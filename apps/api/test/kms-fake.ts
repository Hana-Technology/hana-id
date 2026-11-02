// A fake AWS KMS for the identity token's KMS signer (src/identity/kms.ts): `TrentService.Sign` on one P-256 key,
// signing the 32-byte digest it receives with a real private key (@noble/curves, an implementation independent of the
// adapter's WebCrypto verify and its DER parser), answering KMS's DER `ECDSA-Sig-Value`. It checks the request as KMS
// would (endpoint, target, body fields, and the SigV4 signature recomputed with the fake's own secret), and can be told
// to refuse, hang, drop the connection or answer garbage. Credentials and keys are throwaway values made per instance.
import { p256 } from '@noble/curves/nist';
import { type P256PublicJwk, identityJwksEntry } from '@hana-id/core/identity';
import { AwsV4Signer } from 'aws4fetch';
import { vi } from 'vitest';
import { base64Decode, base64Encode, base64UrlEncode } from '../src/bytes.ts';

const P256_N = p256.CURVE.n;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const randomFrom = (alphabet: string, n: number): string => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join('');

/** A minimal DER INTEGER for a positive value (independent of the adapter's parser). */
function derInteger(v: bigint): number[] {
  let hex = v.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = hex.match(/../gu)!.map((h) => parseInt(h, 16));
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return [0x02, bytes.length, ...bytes];
}

/** DER `SEQUENCE { r INTEGER, s INTEGER }`. */
export function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = [...derInteger(r), ...derInteger(s)];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export interface KmsCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** What the fake answers instead of a valid signature. */
export type KmsMode =
  | { kind: 'sign'; highS?: boolean }
  | { kind: 'refuse'; status: number; type: string }
  | { kind: 'raw'; status: number; body: string | Uint8Array; headers?: Record<string, string> }
  /** A valid answer, then changed: a wrong KeyId or algorithm, a broken or foreign signature… */
  | { kind: 'patch'; patch: (answer: Record<string, unknown>, ctx: { digest: Uint8Array; sign: (digest: Uint8Array) => Uint8Array }) => unknown }
  | { kind: 'hang' }
  | { kind: 'network' };

export class FakeKms {
  readonly region: string;
  readonly arn: string;
  readonly accessKeyId = `AKIA${randomFrom(B32, 16)}`;
  readonly secretAccessKey = randomFrom(SECRET_CHARS, 40);
  readonly publicJwk: P256PublicJwk;
  readonly jwksEntry: ReturnType<typeof identityJwksEntry>;
  readonly calls: KmsCall[] = [];
  /** Requests the fake refused as malformed (wrong target, fields or SigV4), with why. */
  readonly problems: string[] = [];
  mode: KmsMode = { kind: 'sign' };
  private readonly priv: Uint8Array;

  constructor(region = 'ap-east-1') {
    this.region = region;
    this.arn = `arn:aws:kms:${region}:111122223333:key/${crypto.randomUUID()}`;
    this.priv = p256.utils.randomPrivateKey();
    const point = p256.getPublicKey(this.priv, false);
    this.publicJwk = { kty: 'EC', crv: 'P-256', x: base64UrlEncode(point.subarray(1, 33)), y: base64UrlEncode(point.subarray(33, 65)) };
    this.jwksEntry = identityJwksEntry(this.publicJwk);
  }

  get kid(): string {
    return this.jwksEntry.kid;
  }

  /** The DER signature KMS would answer for `digest` (optionally the high-S twin, which is just as valid). */
  signDigest(digest: Uint8Array, highS = false): Uint8Array {
    const sig = p256.sign(digest, this.priv, { lowS: true, prehash: false });
    return derSignature(sig.r, highS ? P256_N - sig.s : sig.s);
  }

  /** The Worker bindings that select this key (the JWKS keeps `extraKeys` too, as during a rotation). */
  env(extraKeys: unknown[] = []): Record<string, string> {
    return {
      IDENTITY_SIGNER: 'aws-kms',
      IDENTITY_KMS_KEY_ARN: this.arn,
      IDENTITY_ACTIVE_KID: this.kid,
      IDENTITY_PUBLIC_KEYS: JSON.stringify([this.jwksEntry, ...extraKeys]),
      IDENTITY_AWS_ACCESS_KEY_ID: this.accessKeyId,
      IDENTITY_AWS_SECRET_ACCESS_KEY: this.secretAccessKey,
    };
  }

  /** Intercepts calls to this region's KMS endpoint; any other fetch goes to the stub already installed (NearMock). */
  install(): void {
    const spy = vi.isMockFunction(globalThis.fetch) ? vi.mocked(globalThis.fetch) : vi.spyOn(globalThis, 'fetch');
    const inner = spy.getMockImplementation();
    spy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://kms.')) return this.handle(input instanceof Request ? input : new Request(url, init));
      if (inner) return inner(input, init);
      return Promise.reject(new Error(`Unexpected fetch to ${url}`));
    });
  }

  async handle(req: Request): Promise<Response> {
    const text = new TextDecoder().decode(await req.arrayBuffer());
    const headers = Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v]));
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.problems.push('body is not JSON');
    }
    this.calls.push({ url: req.url, headers, body });
    const refuse = (problem: string, type: string) => {
      this.problems.push(problem);
      return Response.json({ __type: type, message: problem }, { status: 400 });
    };
    if (req.method !== 'POST' || req.url !== `https://kms.${this.region}.amazonaws.com/`) return refuse(`endpoint ${req.method} ${req.url}`, 'UnknownOperationException');
    if (headers['x-amz-target'] !== 'TrentService.Sign' || headers['content-type'] !== 'application/x-amz-json-1.1') return refuse('target or content type', 'UnknownOperationException');
    if (!(await this.sigV4Matches(req, headers, text))) return refuse('SigV4 signature', 'InvalidSignatureException');
    const keys = Object.keys(body).sort().join();
    if (keys !== 'KeyId,Message,MessageType,SigningAlgorithm') return refuse(`fields ${keys}`, 'ValidationException');
    if (body.KeyId !== this.arn) return Response.json({ __type: 'NotFoundException' }, { status: 400 });
    if (body.MessageType !== 'DIGEST' || body.SigningAlgorithm !== 'ECDSA_SHA_256') return refuse('message type or algorithm', 'ValidationException');
    const digest = base64Decode(String(body.Message));
    if (digest.length !== 32) return refuse('digest length', 'ValidationException');

    const mode = this.mode;
    if (mode.kind === 'hang') {
      return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    if (mode.kind === 'network') throw new TypeError('Network connection lost.');
    if (mode.kind === 'refuse') return Response.json({ __type: `com.amazonaws.kms#${mode.type}`, message: 'refused' }, { status: mode.status });
    if (mode.kind === 'raw') return new Response(mode.body, { status: mode.status, headers: mode.headers });
    const answer = { KeyId: this.arn, Signature: base64Encode(this.signDigest(digest, mode.kind === 'sign' && mode.highS)), SigningAlgorithm: 'ECDSA_SHA_256' };
    if (mode.kind === 'patch') return Response.json(mode.patch(answer, { digest, sign: (d) => this.signDigest(d) }));
    return Response.json(answer);
  }

  /** Recomputes the request's SigV4 Authorization with this fake's own secret, region and service. */
  private async sigV4Matches(req: Request, headers: Record<string, string>, body: string): Promise<boolean> {
    const auth = headers.authorization ?? '';
    const datetime = headers['x-amz-date'] ?? '';
    if (!auth.startsWith(`AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${datetime.slice(0, 8)}/${this.region}/kms/aws4_request, `)) return false;
    const { authorization: _a, ...rest } = headers;
    const signer = new AwsV4Signer({ method: req.method, url: req.url, headers: rest, body, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, service: 'kms', region: this.region, datetime });
    const signed = await signer.sign();
    return signed.headers.get('authorization') === auth;
  }
}
