// The AWS KMS signer (spec "Signing key (staged)", "Mainnet: AWS KMS"): `TrentService.Sign` with
// `MessageType=DIGEST` and `RSASSA_PKCS1_V1_5_SHA_256` on an `RSA_2048` key, SigV4-signed with aws4fetch. Written and
// tested against a fake KMS in build plan batch 4; wired to no env until batch 10 (gen refuses `aws-kms`). The issuer's
// IAM user may only call kms:Sign on the issuer's keys with the algorithm and DIGEST pinned (IAM conditions), so this
// adapter asks for nothing else. Every signature is still checked by jws.ts against the published key.
import { base64Decode, base64Encode, sha256 } from './bytes.ts';
import { AwsClient } from 'aws4fetch';
import { responseJson } from './http.ts';
import { type IssuerSigner, SignerUnavailable } from './signer.ts';

export const KMS_SIGNING_ALGORITHM = 'RSASSA_PKCS1_V1_5_SHA_256';
export const KMS_TIMEOUT_MS = 5000;
/** A Sign answer is ~700 bytes; anything larger is refused unread. */
export const KMS_MAX_RESPONSE_BYTES = 16 * 1024;

export interface KmsSignerConfig {
  signerId: string;
  kid: string;
  /** Full key ARN (the answer's KeyId must equal it). */
  keyArn: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected for tests (default global fetch). */
  fetch?: typeof fetch;
  /** Fixed SigV4 time (`YYYYMMDDTHHMMSSZ`), tests only. */
  datetime?: string;
}

/** KMS error types (`__type`) mapped to the reasons the issuer logs; anything else is `kms_error`. */
export const KMS_ERRORS: Readonly<Record<string, string>> = {
  AccessDeniedException: 'kms_access_denied',
  DisabledException: 'kms_key_disabled',
  KMSInvalidStateException: 'kms_key_disabled',
  NotFoundException: 'kms_key_not_found',
  InvalidKeyUsageException: 'kms_key_usage',
  ThrottlingException: 'kms_throttled',
  LimitExceededException: 'kms_throttled',
  KMSInternalException: 'kms_internal',
  DependencyTimeoutException: 'kms_internal',
};

export class KmsSigner implements IssuerSigner {
  readonly signerId: string;
  readonly kid: string;
  private readonly client: AwsClient;
  private readonly url: string;

  constructor(private readonly cfg: KmsSignerConfig) {
    if (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/u.test(cfg.keyArn)) throw new SignerUnavailable('malformed KMS key ARN');
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(cfg.region)) throw new SignerUnavailable('malformed AWS region');
    this.signerId = cfg.signerId;
    this.kid = cfg.kid;
    // retries: 0: aws4fetch retries 5xx and 429 by default, which would multiply Sign calls (and the reconciliation's count).
    this.client = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 'kms', region: cfg.region, retries: 0 });
    this.url = `https://kms.${cfg.region}.amazonaws.com/`;
  }

  /** The signed request for one digest (exported for the request-shape test). */
  async signedRequest(digest: Uint8Array): Promise<Request> {
    if (digest.length !== 32) throw new SignerUnavailable('a KMS DIGEST is 32 bytes');
    const body = JSON.stringify({ KeyId: this.cfg.keyArn, Message: base64Encode(digest), MessageType: 'DIGEST', SigningAlgorithm: KMS_SIGNING_ALGORITHM });
    return this.client.sign(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'TrentService.Sign' },
      body,
      ...(this.cfg.datetime ? { aws: { datetime: this.cfg.datetime } } : {}),
    });
  }

  async sign(input: Uint8Array): Promise<Uint8Array> {
    const req = await this.signedRequest(sha256(input));
    let res: Response;
    try {
      res = await (this.cfg.fetch ?? fetch)(req, { signal: AbortSignal.timeout(KMS_TIMEOUT_MS) });
    } catch {
      throw new SignerUnavailable('kms_unreachable');
    }
    const body = await responseJson(res, KMS_MAX_RESPONSE_BYTES);
    const o = (body ?? {}) as Record<string, unknown>;
    if (!res.ok) {
      const type = typeof o.__type === 'string' ? o.__type.split('#').pop()! : '';
      throw new SignerUnavailable(KMS_ERRORS[type] ?? 'kms_error');
    }
    if (o.KeyId !== this.cfg.keyArn || o.SigningAlgorithm !== KMS_SIGNING_ALGORITHM || typeof o.Signature !== 'string') throw new SignerUnavailable('kms_bad_answer');
    let sig: Uint8Array;
    try {
      sig = base64Decode(o.Signature);
    } catch {
      throw new SignerUnavailable('kms_bad_answer');
    }
    if (sig.length < 256 || sig.length > 512) throw new SignerUnavailable('kms_bad_answer');
    return sig;
  }
}
