// The identity token's configuration and signer (docs/identity-token-spec.md "Signing key, JWKS and rotation").
//
// Configuration (scripts/gen-wrangler.ts from the manifest's `identityToken`): IDENTITY_ISS, IDENTITY_PUBLIC_KEYS (the
// JWKS: every key a token may be signed with now) and IDENTITY_ACTIVE_KID (the key that signs). Secrets
// (scripts/identity-key.ts): IDENTITY_SIGNING_KEY and IDENTITY_SIGNING_KEY_STANDBY (P-256 private JWKs, testnet and
// `local*` only) and IDENTITY_SUB_KEY (32 bytes, base64).
//
// `IdentitySigner` has two adapters, picked by signers.ts from IDENTITY_SIGNER: the Worker-secret one here and AWS KMS
// (kms.ts, build step 7). The endpoint only ever calls `sign` and reads `kid`. Whatever signs, the signature is
// verified with the manifest's public key for `kid` before a token is answered, so a secret that doesn't match the
// published key (or a KMS wiring fault) never reaches a partner.
//
// SECURITY: the private JWKs and IDENTITY_SUB_KEY never leave this module's memory; nothing here logs them.
import { type P256PublicJwk, identityJwksEntry, isP256PublicJwk, jwkThumbprint } from '@hana-id/core/identity';
import { base64Decode } from '../bytes.ts';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

export interface IdentitySigner {
  /** RFC 7638 thumbprint of the signing key: the token header's `kid`. */
  readonly kid: string;
  /** An ES256 signature over the JWS signing input, in JOSE form (64 bytes, r ‖ s). */
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export type JwksEntry = ReturnType<typeof identityJwksEntry>;

export interface IdentityConfig {
  iss: string;
  /** The JWKS, from IDENTITY_PUBLIC_KEYS (public members only). */
  keys: JwksEntry[];
  activeKid: string;
  /** IDENTITY_SUB_KEY: the `sub`/`sid` HMAC key. */
  subKey: Uint8Array;
}

/** Why the identity token can't be served (logged as a code, never a value). */
export type IdentityConfigProblem = 'no_identity_config' | 'bad_public_keys' | 'active_kid_not_published' | 'no_sub_key' | 'bad_sub_key';

/** The public half of the configuration, which the JWKS and discovery endpoints need (no secret). */
export function publicIdentityConfig(env: Pick<Env, 'IDENTITY_ISS' | 'IDENTITY_PUBLIC_KEYS' | 'IDENTITY_ACTIVE_KID'>): { iss: string; keys: JwksEntry[]; activeKid: string } | IdentityConfigProblem {
  if (!env.IDENTITY_ISS || !env.IDENTITY_PUBLIC_KEYS || !env.IDENTITY_ACTIVE_KID) return 'no_identity_config';
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.IDENTITY_PUBLIC_KEYS);
  } catch {
    return 'bad_public_keys';
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 4) return 'bad_public_keys';
  const keys: JwksEntry[] = [];
  for (const k of parsed) {
    // Public members only: an entry carrying a private member is refused outright, never filtered.
    if (!isP256PublicJwk(k) || 'd' in (k as object)) return 'bad_public_keys';
    const entry = identityJwksEntry(k);
    if ((k as { kid?: unknown }).kid !== undefined && (k as { kid?: unknown }).kid !== entry.kid) return 'bad_public_keys';
    if (keys.some((e) => e.kid === entry.kid)) return 'bad_public_keys';
    keys.push(entry);
  }
  if (!keys.some((k) => k.kid === env.IDENTITY_ACTIVE_KID)) return 'active_kid_not_published';
  return { iss: env.IDENTITY_ISS, keys, activeKid: env.IDENTITY_ACTIVE_KID };
}

const SUB_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;

/**
 * IDENTITY_SUB_KEY alone (32 bytes from base64), or why not. The token's `sub` and the wallet directory's User ID
 * (directory/store.ts, D346) both come from it.
 */
export function identitySubKey(env: Pick<Env, 'IDENTITY_SUB_KEY'>): Uint8Array | 'no_sub_key' | 'bad_sub_key' {
  if (!env.IDENTITY_SUB_KEY) return 'no_sub_key';
  if (!SUB_KEY_RE.test(env.IDENTITY_SUB_KEY)) return 'bad_sub_key';
  const subKey = base64Decode(env.IDENTITY_SUB_KEY);
  return subKey.length === 32 ? subKey : 'bad_sub_key';
}

/** The whole configuration for minting, or the first problem. */
export function identityConfig(env: Env): IdentityConfig | IdentityConfigProblem {
  const pub = publicIdentityConfig(env);
  if (typeof pub === 'string') return pub;
  const subKey = identitySubKey(env);
  if (typeof subKey === 'string') return subKey;
  return { ...pub, subKey };
}

// ---- Worker-secret signer (testnet, local*) ----

interface PrivateJwk extends P256PublicJwk {
  d: string;
}

const isPrivateJwk = (v: unknown): v is PrivateJwk => isP256PublicJwk(v) && typeof (v as PrivateJwk).d === 'string' && /^[A-Za-z0-9_-]{43}$/u.test((v as PrivateJwk).d);

function parsePrivateJwk(secret: string | undefined): PrivateJwk | null {
  if (!secret) return null;
  try {
    const v: unknown = JSON.parse(secret);
    return isPrivateJwk(v) ? v : null;
  } catch {
    return null;
  }
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ES256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Verifies a JOSE ES256 signature against a published key (WebCrypto takes the same r ‖ s form). */
export async function verifyEs256(jwk: P256PublicJwk, signature: Uint8Array, signingInput: Uint8Array): Promise<boolean> {
  if (signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, ECDSA_P256, false, ['verify']);
    return await crypto.subtle.verify(ES256, key, signature, signingInput);
  } catch {
    return false;
  }
}

/**
 * Signs with a P-256 private key held as a Worker secret, then checks the signature with the published key for its kid
 * (WebCrypto's ECDSA output is already the JOSE r ‖ s form).
 */
export class WorkerSecretSigner implements IdentitySigner {
  private constructor(
    readonly kid: string,
    private readonly key: CryptoKey,
    private readonly published: P256PublicJwk,
  ) {}

  static async create(jwk: PrivateJwk, published: P256PublicJwk): Promise<WorkerSecretSigner> {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: false }, ECDSA_P256, false, ['sign']);
    return new WorkerSecretSigner(jwkThumbprint(published), key, published);
  }

  async sign(signingInput: Uint8Array): Promise<Uint8Array> {
    const signature = new Uint8Array(await crypto.subtle.sign(ES256, this.key, signingInput));
    if (!(await verifyEs256(this.published, signature, signingInput))) throw new IdentitySignerError('self_verify_failed');
    return signature;
  }
}

export class IdentitySignerError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'IdentitySignerError';
  }
}

/** One signer per isolate for the same secrets and active kid (importKey once). */
let cached: { activeKid: string; published: string; primary: string | undefined; standby: string | undefined; signer: Promise<IdentitySigner> } | null = null;

/**
 * The signer for `activeKid`: whichever of IDENTITY_SIGNING_KEY and IDENTITY_SIGNING_KEY_STANDBY has that thumbprint
 * (the slots are names only; switching keys is a manifest change of the active kid). Throws IdentitySignerError when
 * neither does, or the key won't import.
 */
export function workerSecretSigner(env: Pick<Env, 'IDENTITY_SIGNING_KEY' | 'IDENTITY_SIGNING_KEY_STANDBY'>, config: Pick<IdentityConfig, 'activeKid' | 'keys'>): Promise<IdentitySigner> {
  const publishedKey = config.keys.find((k) => k.kid === config.activeKid);
  const published = publishedKey ? `${publishedKey.x}.${publishedKey.y}` : '';
  if (
    cached &&
    cached.activeKid === config.activeKid &&
    cached.published === published &&
    cached.primary === env.IDENTITY_SIGNING_KEY &&
    cached.standby === env.IDENTITY_SIGNING_KEY_STANDBY
  ) {
    return cached.signer;
  }
  const signer = (async () => {
    const published = config.keys.find((k) => k.kid === config.activeKid);
    if (!published) throw new IdentitySignerError('active_kid_not_published');
    const jwk = [parsePrivateJwk(env.IDENTITY_SIGNING_KEY), parsePrivateJwk(env.IDENTITY_SIGNING_KEY_STANDBY)].find((k) => k !== null && jwkThumbprint(k) === config.activeKid);
    if (!jwk) throw new IdentitySignerError('no_signing_key_for_active_kid');
    try {
      return await WorkerSecretSigner.create(jwk, published);
    } catch {
      throw new IdentitySignerError('signing_key_unusable');
    }
  })();
  cached = { activeKid: config.activeKid, published, primary: env.IDENTITY_SIGNING_KEY, standby: env.IDENTITY_SIGNING_KEY_STANDBY, signer };
  signer.catch((e: unknown) => {
    if (cached?.signer === signer) cached = null;
    log({ event: 'identity_signer_unavailable', code: e instanceof IdentitySignerError ? e.reason : 'internal' }, 'error');
  });
  return signer;
}

/** Tests only. */
export function clearIdentitySignerCache(): void {
  cached = null;
}
