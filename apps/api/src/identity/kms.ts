// The identity token's AWS KMS signer (docs/identity-token-spec.md "Where the key lives", build step 7, D215–D218).
//
// `TrentService.Sign` on an `ECC_NIST_P256` `SIGN_VERIFY` key with `SigningAlgorithm=ECDSA_SHA_256` and
// `MessageType=DIGEST`, SigV4-signed with aws4fetch (as the email issuer's RSA adapter, D121). The Worker hashes the
// JWS signing input itself and sends only the 32-byte digest (D216): the token's claims (`sub`, `sid`, wallets, later
// the email) never reach AWS, the request has a fixed size whatever the token's, and the IAM policy pins
// `kms:MessageType = DIGEST`.
//
// KMS answers a DER `ECDSA-Sig-Value`; `derToJose` converts it strictly to JOSE's 64-byte r ‖ s (D217), and the
// result is verified with the manifest's published key before the caller sees it: a wiring fault (the wrong ARN, a key
// whose public half isn't the one published) never reaches a partner.
//
// Limits (D218): one Sign request per mint, no retry (aws4fetch's own retries are off, and this module never calls
// twice), a deadline over the request and the body together, and a body cap. A failure is an IdentitySignerError with
// a reason code, which token.ts logs and answers as 503 identity_signer_unavailable.
//
// SECURITY: the AWS credentials are used only to sign the request; nothing here logs them, the request (its
// Authorization header) or a signature. Error reasons are fixed codes, never values from the answer.
import { AwsClient } from 'aws4fetch';
import type { P256PublicJwk } from '@hana-id/core/identity';
import { base64Encode, sha256 } from '../bytes.ts';
import { IdentitySignerError, type IdentitySigner, verifyEs256 } from './signer.ts';

export const KMS_SIGNING_ALGORITHM = 'ECDSA_SHA_256';
/** A whole Sign call, the body included (KMS answers in tens of ms; the spec's budget is ≤ 100 ms p95). */
export const KMS_TIMEOUT_MS = 3000;
/** A Sign answer is about 300 bytes (the key ARN, a ≤ 72-byte signature in base64, the algorithm). */
export const KMS_MAX_RESPONSE_BYTES = 4096;

/** Same patterns as `@hana-id/env` (KMS_KEY_ARN_RE): single-region keys in the standard partition. */
const KEY_ARN_RE = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):\d{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** A long-term IAM user access key (`AKIA…`); temporary `ASIA…` keys need a session token this signer doesn't take. */
const ACCESS_KEY_ID_RE = /^AKIA[A-Z2-7]{16}$/u;
const SECRET_ACCESS_KEY_RE = /^[A-Za-z0-9/+]{40}$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/**
 * The error type of a KMS answer's `__type`: without the namespace (`com.amazonaws.kms#…`) or a trailing `:http…` (the
 * form AWS's JSON protocols use for some errors, e.g. `UnrecognizedClientException:http://internal.amazon.com/…`).
 */
export function kmsErrorType(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.split('#').pop()!.split(':')[0]!;
}

/** KMS error types (`kmsErrorType`) mapped to the reasons logged; anything else is `kms_error`. */
export const KMS_ERRORS: Readonly<Record<string, string>> = {
  AccessDeniedException: 'kms_access_denied',
  UnrecognizedClientException: 'kms_bad_credentials',
  InvalidSignatureException: 'kms_bad_credentials',
  IncompleteSignature: 'kms_bad_credentials',
  IncompleteSignatureException: 'kms_bad_credentials',
  ExpiredTokenException: 'kms_bad_credentials',
  DisabledException: 'kms_key_disabled',
  KMSInvalidStateException: 'kms_key_disabled',
  NotFoundException: 'kms_key_not_found',
  InvalidKeyUsageException: 'kms_key_usage',
  KeyUnavailableException: 'kms_internal',
  ThrottlingException: 'kms_throttled',
  LimitExceededException: 'kms_throttled',
  KMSInternalException: 'kms_internal',
  DependencyTimeoutException: 'kms_internal',
};

// ---- DER ECDSA-Sig-Value → JOSE r ‖ s (P-256) ----

/** The P-256 group order n: r and s are in [1, n − 1]. */
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

const fail = (): never => {
  throw new IdentitySignerError('kms_bad_signature');
};

function toBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/**
 * Converts KMS's DER `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }` to the 64-byte JOSE form (RFC 7518
 * §3.4: r and s as 32-byte big-endian values, left-padded with zeros). Strict DER (D217): one SEQUENCE with a short-form
 * length equal to the rest of the input (a P-256 signature is at most 72 bytes, so the long form is never DER), two
 * INTEGERs each of 1–33 content bytes, minimal (a leading 0x00 only before a byte with its high bit set), non-negative,
 * and in [1, n − 1]; nothing after `s`. Any other input throws `kms_bad_signature`. High-S values are kept: JOSE
 * doesn't require low-S, and the verifier (WebCrypto) accepts both.
 */
export function derToJose(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2) fail();
  const out = new Uint8Array(64);
  let off = 2;
  for (const at of [0, 32]) {
    if (off + 2 > der.length || der[off] !== 0x02) fail();
    const len = der[off + 1]!;
    if (len < 1 || len > 33 || off + 2 + len > der.length) fail();
    let v = der.subarray(off + 2, off + 2 + len);
    if (v[0]! & 0x80) fail(); // negative
    if (v[0] === 0x00) {
      if (len === 1 || !(v[1]! & 0x80)) fail(); // zero, or a non-minimal leading zero
      v = v.subarray(1);
    }
    if (v.length > 32) fail();
    const n = toBigInt(v);
    if (n === 0n || n >= P256_N) fail();
    out.set(v, at + 32 - v.length);
    off += 2 + len;
  }
  if (off !== der.length) fail();
  return out;
}

// ---- the signer ----

export interface KmsSignerConfig {
  /** The kid the manifest names for this key (`identityToken.signer.keys.active.kid`, IDENTITY_ACTIVE_KID). */
  kid: string;
  /** The key's full ARN (IDENTITY_KMS_KEY_ARN); the answer's KeyId must equal it. Its region picks the endpoint. */
  keyArn: string;
  /** The published public key with `kid`: every signature is verified with it before it is returned. */
  published: P256PublicJwk;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected for tests (default: the global fetch). */
  fetch?: typeof fetch;
  /** Tests only: a shorter deadline. */
  timeoutMs?: number;
}

/** A body of at most `max` bytes as JSON, or null (larger, unreadable or not JSON). Never logged. */
async function cappedJson(res: Response, max: number): Promise<unknown> {
  const declared = res.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= max)) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const buf = new Uint8Array(max);
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      buf.set(value, size);
      size += value.byteLength;
    }
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf.subarray(0, size))) as unknown;
  } catch {
    return null;
  }
}

function decodeBase64(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0 || !BASE64_RE.test(s)) return null;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class KmsIdentitySigner implements IdentitySigner {
  readonly kid: string;
  private readonly client: AwsClient;
  private readonly url: string;

  /** Throws IdentitySignerError on a malformed ARN or credentials (reasons only, never the values). */
  constructor(private readonly cfg: KmsSignerConfig) {
    const region = KEY_ARN_RE.exec(cfg.keyArn)?.[1];
    if (!region) throw new IdentitySignerError('kms_bad_key_arn');
    if (!ACCESS_KEY_ID_RE.test(cfg.accessKeyId) || !SECRET_ACCESS_KEY_RE.test(cfg.secretAccessKey)) throw new IdentitySignerError('kms_bad_credentials_format');
    this.kid = cfg.kid;
    // retries: 0 — aws4fetch's AwsClient.fetch retries 5xx and 429; this class only uses `sign` and one fetch, but a
    // later change to `client.fetch` must not start multiplying Sign calls (and the reconciliation's count, D218).
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 'kms', region, retries: 0 });
    this.url = `https://kms.${region}.amazonaws.com/`;
  }

  /** The SigV4-signed Sign request for one 32-byte digest (exported for the request-shape test). */
  async signedRequest(digest: Uint8Array, signal?: AbortSignal): Promise<Request> {
    if (digest.length !== 32) throw new IdentitySignerError('kms_bad_digest');
    const body = JSON.stringify({ KeyId: this.cfg.keyArn, Message: base64Encode(digest), MessageType: 'DIGEST', SigningAlgorithm: KMS_SIGNING_ALGORITHM });
    return this.client.sign(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'TrentService.Sign' },
      body,
      ...(signal ? { signal } : {}),
    });
  }

  async sign(signingInput: Uint8Array): Promise<Uint8Array> {
    const digest = await sha256(signingInput);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new IdentitySignerError('kms_timeout'));
      }, this.cfg.timeoutMs ?? KMS_TIMEOUT_MS);
    });
    let answer: { ok: boolean; body: unknown };
    try {
      answer = await Promise.race([this.call(digest, controller.signal), deadline]);
    } finally {
      clearTimeout(timer);
    }
    const o = (answer.body ?? {}) as Record<string, unknown>;
    if (!answer.ok) {
      const type = kmsErrorType(o.__type);
      throw new IdentitySignerError(Object.hasOwn(KMS_ERRORS, type) ? KMS_ERRORS[type]! : 'kms_error');
    }
    if (typeof answer.body !== 'object' || answer.body === null || Array.isArray(answer.body)) throw new IdentitySignerError('kms_bad_answer');
    if (o.KeyId !== this.cfg.keyArn || o.SigningAlgorithm !== KMS_SIGNING_ALGORITHM || typeof o.Signature !== 'string') throw new IdentitySignerError('kms_bad_answer');
    const der = decodeBase64(o.Signature);
    if (!der) throw new IdentitySignerError('kms_bad_answer');
    const signature = derToJose(der);
    if (!(await verifyEs256(this.cfg.published, signature, signingInput))) throw new IdentitySignerError('self_verify_failed');
    return signature;
  }

  private async call(digest: Uint8Array, signal: AbortSignal): Promise<{ ok: boolean; body: unknown }> {
    const req = await this.signedRequest(digest, signal);
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(req);
    } catch {
      throw new IdentitySignerError(signal.aborted ? 'kms_timeout' : 'kms_unreachable');
    }
    return { ok: res.ok, body: await cappedJson(res, KMS_MAX_RESPONSE_BYTES).catch(() => null) };
  }
}
