// The issuer's signers (spec "Signing key (staged)", D121): `IssuerSigner` signs one JWS entry's signing input for one
// signer id with one kid. Two adapters: the Worker-secret RSA key (testnet, here) and AWS KMS (kms.ts; written and tested,
// wired to no env until build plan batch 10). The JWS General JSON form (jws.ts) takes one signer per entry, so a
// co-signer (Level 1) is another IssuerSigner and no format change.
import { rsaThumbprint } from '@hana-id/jwks';

export interface PublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  use: 'sig';
  alg: 'RS256';
}

export interface IssuerSigner {
  /** The signer id of the on-chain policy (`hana` at launch). */
  readonly signerId: string;
  /** The kid of the key this signer signs with (its RFC 7638 thumbprint). */
  readonly kid: string;
  /**
   * RS256 (RSASSA-PKCS1-v1_5 over SHA-256) of `input` = ASCII(protected ‖ "." ‖ payload). WebCrypto hashes the input
   * itself; the KMS adapter hashes it and sends the 32-byte digest (`MessageType=DIGEST`).
   */
  sign(input: Uint8Array): Promise<Uint8Array>;
}

/** The signer is misconfigured or unreachable (answered 503 signer_unavailable; nothing reaches the chain). */
export class SignerUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`signer unavailable: ${reason}`);
    this.name = 'SignerUnavailable';
  }
}

interface RsaPrivateJwk {
  kty: 'RSA';
  n: string;
  e: string;
  d: string;
  p: string;
  q: string;
  dp: string;
  dq: string;
  qi: string;
}

const B64URL = /^[A-Za-z0-9_-]+$/u;

export function isRsaPrivateJwk(v: unknown): v is RsaPrivateJwk {
  const k = v as Record<string, unknown> | null;
  return !!k && typeof k === 'object' && k.kty === 'RSA' && ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].every((f) => typeof k[f] === 'string' && B64URL.test(k[f] as string));
}

/**
 * The testnet signer: ISSUER_SIGNING_KEY, an RSA private JWK held as a Worker secret (exportable: accepted for testnet
 * only, D121). The key's thumbprint must equal the manifest's active kid, or nothing is signed.
 */
export class WorkerSecretSigner implements IssuerSigner {
  private constructor(
    readonly signerId: string,
    readonly kid: string,
    private readonly key: CryptoKey,
  ) {}

  static async create(secret: string | undefined, expectedKid: string, signerId = 'hana'): Promise<WorkerSecretSigner> {
    if (!secret) throw new SignerUnavailable('ISSUER_SIGNING_KEY is not set');
    let jwk: unknown;
    try {
      jwk = JSON.parse(secret);
    } catch {
      throw new SignerUnavailable('ISSUER_SIGNING_KEY is not JSON');
    }
    if (!isRsaPrivateJwk(jwk)) throw new SignerUnavailable('ISSUER_SIGNING_KEY is not an RSA private JWK');
    const kid = await rsaThumbprint({ n: jwk.n, e: jwk.e });
    if (kid !== expectedKid) throw new SignerUnavailable('ISSUER_SIGNING_KEY is not the manifest’s active key');
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, d: jwk.d, p: jwk.p, q: jwk.q, dp: jwk.dp, dq: jwk.dq, qi: jwk.qi, alg: 'RS256', ext: false },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    } catch {
      throw new SignerUnavailable('ISSUER_SIGNING_KEY does not import');
    }
    return new WorkerSecretSigner(signerId, kid, key);
  }

  async sign(input: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.key, new Uint8Array(input)));
  }
}

/** Verifies one RS256 signature against a public JWK (the self-check and the tests). */
export async function verifyRs256(jwk: { n: string; e: string }, input: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, new Uint8Array(signature), new Uint8Array(input));
  } catch {
    return false;
  }
}

/** The manifest's published keys (EMAIL_PUBLIC_KEYS), each kid checked against its thumbprint. */
export async function parsePublicKeys(raw: string | undefined): Promise<PublicJwk[]> {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? '');
  } catch {
    throw new SignerUnavailable('EMAIL_PUBLIC_KEYS is not JSON');
  }
  if (!Array.isArray(list) || list.length === 0) throw new SignerUnavailable('EMAIL_PUBLIC_KEYS is empty');
  const out: PublicJwk[] = [];
  for (const k of list as Record<string, unknown>[]) {
    if (!k || k.kty !== 'RSA' || typeof k.n !== 'string' || typeof k.e !== 'string' || typeof k.kid !== 'string' || 'd' in k) throw new SignerUnavailable('EMAIL_PUBLIC_KEYS has a malformed key');
    if ((await rsaThumbprint({ n: k.n, e: k.e })) !== k.kid) throw new SignerUnavailable('EMAIL_PUBLIC_KEYS has a kid that is not its thumbprint');
    out.push({ kty: 'RSA', n: k.n, e: k.e, kid: k.kid, use: 'sig', alg: 'RS256' });
  }
  return out;
}
