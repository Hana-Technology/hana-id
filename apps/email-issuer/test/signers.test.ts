// The signers (spec "Signing key (staged)", D121): the JWS JSON form with one and two signatures, the self-check, the
// Worker-secret signer, and the KMS adapter against a fake KMS: the SigV4 request shape against an independently
// computed signature, DIGEST mode, error mapping, and byte-for-byte parity with the Worker-secret signer (RS256 is
// deterministic, so the same key signs the same bytes).
import { describe, expect, it } from 'vitest';
import { base64Decode, base64Encode, base64UrlDecode, fromUtf8, sha256, toHex, utf8 } from '../src/bytes.ts';
import { type EmailClaims, mintJws } from '../src/jws.ts';
import { KmsSigner } from '../src/kms.ts';
import { type IssuerSigner, type PublicJwk, SignerUnavailable, WorkerSecretSigner, parsePublicKeys, verifyRs256 } from '../src/signer.ts';
import { env } from './helpers.ts';

const claims = (): EmailClaims => ({ iss: env.EMAIL_ISS, aud: 'email:s1', sub: 'e1.' + 'A'.repeat(43), iat: 1_800_000_000, exp: 1_800_000_600, nonce: 'N'.repeat(43), jti: 'J'.repeat(22) });
const ARN = 'arn:aws:kms:ap-east-1:123456789012:key/0f1e2d3c-4b5a-4968-8776-655443322110';
const DATETIME = '20261102T050000Z';

/** A fake KMS: Sign over a DIGEST it was told about (the test registers the input), with the given private key. */
function fakeKms(privateJwk: string, opts: { status?: number; body?: unknown; keyId?: string } = {}) {
  const inputs = new Map<string, Uint8Array>();
  const requests: Request[] = [];
  let key: CryptoKey | null = null;
  const fetcher = (async (req: Request) => {
    requests.push(req.clone());
    if (opts.status && opts.status !== 200) return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status });
    const body = JSON.parse(fromUtf8(new Uint8Array(await req.arrayBuffer()))) as { KeyId: string; Message: string; MessageType: string; SigningAlgorithm: string };
    key ??= await crypto.subtle.importKey('jwk', JSON.parse(privateJwk), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const input = inputs.get(toHex(base64Decode(body.Message)));
    if (!input) return new Response(JSON.stringify({ __type: 'ValidationException' }), { status: 400 });
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, input));
    return new Response(JSON.stringify(opts.body ?? { KeyId: opts.keyId ?? body.KeyId, Signature: base64Encode(sig), SigningAlgorithm: body.SigningAlgorithm }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, requests, expect: (input: Uint8Array) => inputs.set(toHex(sha256(input)), input) };
}

const kms = (f: { fetcher: typeof fetch }, kid = env.EMAIL_ACTIVE_KID) =>
  new KmsSigner({ signerId: 'hana', kid, keyArn: ARN, region: 'ap-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', fetch: f.fetcher, datetime: DATETIME });

/** An independent SigV4 (AWS's documented algorithm, Web Crypto only) for the recorded-vector check. */
async function sigv4(body: string, amzDate: string, region: string): Promise<string> {
  const hmac = async (key: Uint8Array, data: string) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), utf8(data)));
  const day = amzDate.slice(0, 8);
  const host = `kms.${region}.amazonaws.com`;
  // aws4fetch signs host, x-amz-date and x-amz-target (content-type is left unsigned, as SigV4 allows).
  const signed = 'host;x-amz-date;x-amz-target';
  const payloadHash = toHex(sha256(utf8(body)));
  const canonical = ['POST', '/', '', `host:${host}`, `x-amz-date:${amzDate}`, `x-amz-target:TrentService.Sign`, '', signed, payloadHash].join('\n');
  const scope = `${day}/${region}/kms/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, toHex(sha256(utf8(canonical)))].join('\n');
  let k = await hmac(utf8('AWS4wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'), day);
  k = await hmac(k, region);
  k = await hmac(k, 'kms');
  k = await hmac(k, 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/${scope}, SignedHeaders=${signed}, Signature=${toHex(await hmac(k, toSign))}`;
}

describe('JWS JSON (two-signer-ready)', () => {
  it('one signature: the exact form the contract parses', async () => {
    const keys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
    const s = await WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, env.EMAIL_ACTIVE_KID);
    const token = await mintJws(claims(), [s], keys);
    const t = JSON.parse(token) as { payload: string; signatures: { protected: string; signature: string }[] };
    expect(Object.keys(t)).toEqual(['payload', 'signatures']);
    expect(t.signatures).toHaveLength(1);
    expect(fromUtf8(base64UrlDecode(t.signatures[0]!.protected))).toBe(`{"alg":"RS256","kid":"${env.EMAIL_ACTIVE_KID}"}`);
    expect(JSON.parse(fromUtf8(base64UrlDecode(t.payload)))).toEqual(claims());
    expect(await verifyRs256(keys[0]!, utf8(`${t.signatures[0]!.protected}.${t.payload}`), base64UrlDecode(t.signatures[0]!.signature))).toBe(true);
  });

  it('two signatures (a co-signer, Level 1): each entry signs its own protected header and the payload', async () => {
    const keys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
    const standbyKid = keys.find((k) => k.kid !== env.EMAIL_ACTIVE_KID)!.kid;
    const a = await WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, env.EMAIL_ACTIVE_KID);
    const b = await WorkerSecretSigner.create(env.TEST_STANDBY_KEY, standbyKid, 'cosign');
    const t = JSON.parse(await mintJws(claims(), [a, b], keys)) as { payload: string; signatures: { protected: string; signature: string }[] };
    expect(t.signatures).toHaveLength(2);
    for (const [i, kid] of [env.EMAIL_ACTIVE_KID, standbyKid].entries()) {
      const s = t.signatures[i]!;
      expect(JSON.parse(fromUtf8(base64UrlDecode(s.protected)))).toEqual({ alg: 'RS256', kid });
      expect(await verifyRs256(keys.find((k) => k.kid === kid)!, utf8(`${s.protected}.${t.payload}`), base64UrlDecode(s.signature))).toBe(true);
    }
    await expect(mintJws(claims(), [a, a], keys)).rejects.toThrow('duplicate');
    await expect(mintJws(claims(), [a, b, a, b], keys)).rejects.toThrow('1 to 3');
  });

  it('the self-check refuses a signature that doesn’t verify, and an unpublished key', async () => {
    const keys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
    const liar: IssuerSigner = { signerId: 'hana', kid: env.EMAIL_ACTIVE_KID, sign: async () => new Uint8Array(256).fill(7) };
    await expect(mintJws(claims(), [liar], keys)).rejects.toThrow('self-check');
    const wrongKey = await WorkerSecretSigner.create(env.TEST_STANDBY_KEY, keys[1]!.kid);
    const posing: IssuerSigner = { signerId: 'hana', kid: env.EMAIL_ACTIVE_KID, sign: (i) => wrongKey.sign(i) };
    await expect(mintJws(claims(), [posing], keys)).rejects.toThrow('self-check');
    await expect(mintJws(claims(), [wrongKey], keys.slice(0, 1) as PublicJwk[])).rejects.toThrow('not published');
  });

  it('the Worker-secret signer refuses a missing, malformed or non-active key', async () => {
    await expect(WorkerSecretSigner.create(undefined, env.EMAIL_ACTIVE_KID)).rejects.toBeInstanceOf(SignerUnavailable);
    await expect(WorkerSecretSigner.create('{}', env.EMAIL_ACTIVE_KID)).rejects.toThrow('RSA private JWK');
    await expect(WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, 'X'.repeat(43))).rejects.toThrow('active key');
    await expect(parsePublicKeys(JSON.stringify([{ ...JSON.parse(env.EMAIL_PUBLIC_KEYS)[0], kid: 'X'.repeat(43) }]))).rejects.toThrow('thumbprint');
  });
});

describe('KMS adapter (fake KMS)', () => {
  it('SigV4 request shape: TrentService.Sign, DIGEST, RSASSA_PKCS1_V1_5_SHA_256, signed as AWS documents', async () => {
    const f = fakeKms(env.ISSUER_SIGNING_KEY!);
    const signer = kms(f);
    const input = utf8('protected.payload');
    const req = await signer.signedRequest(sha256(input));
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://kms.ap-east-1.amazonaws.com/');
    expect(req.headers.get('x-amz-target')).toBe('TrentService.Sign');
    expect(req.headers.get('content-type')).toBe('application/x-amz-json-1.1');
    expect(req.headers.get('x-amz-date')).toBe(DATETIME);
    const body = fromUtf8(new Uint8Array(await req.arrayBuffer()));
    expect(JSON.parse(body)).toEqual({ KeyId: ARN, Message: base64Encode(sha256(input)), MessageType: 'DIGEST', SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256' });
    expect(req.headers.get('authorization')).toBe(await sigv4(body, DATETIME, 'ap-east-1'));
    await expect(signer.signedRequest(new Uint8Array(31))).rejects.toThrow('32 bytes');
  });

  it('parity: KMS and the Worker-secret signer give the same signature; the token self-checks', async () => {
    const f = fakeKms(env.ISSUER_SIGNING_KEY!);
    const signer = kms(f);
    const keys = await parsePublicKeys(env.EMAIL_PUBLIC_KEYS);
    const local = await WorkerSecretSigner.create(env.ISSUER_SIGNING_KEY, env.EMAIL_ACTIVE_KID);
    const input = utf8('a.b');
    f.expect(input);
    expect(toHex(await signer.sign(input))).toBe(toHex(await local.sign(input)));
    // A full token: every signing input registered by intercepting the signer.
    const intercept: IssuerSigner = { signerId: 'hana', kid: signer.kid, sign: (i) => (f.expect(i), signer.sign(i)) };
    expect(await mintJws(claims(), [intercept], keys)).toBe(await mintJws(claims(), [local], keys));
  });

  it('a KMS signature by the wrong key fails the self-check (a wiring fault never reaches the chain)', async () => {
    const f = fakeKms(env.TEST_STANDBY_KEY);
    const signer = kms(f);
    const intercept: IssuerSigner = { signerId: 'hana', kid: signer.kid, sign: (i) => (f.expect(i), signer.sign(i)) };
    await expect(mintJws(claims(), [intercept], await parsePublicKeys(env.EMAIL_PUBLIC_KEYS))).rejects.toThrow('self-check');
  });

  it('maps KMS errors; refuses odd answers', async () => {
    const cases: [number, unknown, string][] = [
      [400, { __type: 'AccessDeniedException' }, 'kms_access_denied'],
      [400, { __type: 'com.amazonaws.kms#DisabledException' }, 'kms_key_disabled'],
      [400, { __type: 'NotFoundException' }, 'kms_key_not_found'],
      [400, { __type: 'ThrottlingException' }, 'kms_throttled'],
      [500, { __type: 'KMSInternalException' }, 'kms_internal'],
      [400, { __type: 'Weird' }, 'kms_error'],
    ];
    for (const [status, body, reason] of cases) {
      const err = await kms(fakeKms(env.ISSUER_SIGNING_KEY!, { status, body }))
        .sign(utf8('x'))
        .catch((e: SignerUnavailable) => e);
      expect((err as SignerUnavailable).reason).toBe(reason);
    }
    const otherKey = fakeKms(env.ISSUER_SIGNING_KEY!, { keyId: ARN.replace('0f1e', 'aaaa') });
    otherKey.expect(utf8('x'));
    expect(((await kms(otherKey).sign(utf8('x')).catch((e) => e)) as SignerUnavailable).reason).toBe('kms_bad_answer');
    const down = new KmsSigner({ signerId: 'hana', kid: 'k', keyArn: ARN, region: 'ap-east-1', accessKeyId: 'a', secretAccessKey: 'b', fetch: (async () => Promise.reject(new Error('net'))) as unknown as typeof fetch });
    expect(((await down.sign(utf8('x')).catch((e) => e)) as SignerUnavailable).reason).toBe('kms_unreachable');
    expect(() => new KmsSigner({ signerId: 'hana', kid: 'k', keyArn: 'arn:aws:kms:x', region: 'ap-east-1', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow('ARN');
  });

  it('does not retry (one Sign per signature, as the reconciliation counts them)', async () => {
    const f = fakeKms(env.ISSUER_SIGNING_KEY!, { status: 503, body: {} });
    await kms(f).sign(utf8('x')).catch(() => undefined);
    expect(f.requests).toHaveLength(1);
  });
});
