// The partner identity token's manifest block (docs/identity-token-spec.md "D1 schema, manifest and secrets", D127):
// the issuer URL, the signer and the public keys the JWKS serves. The JWKS is generated from `publicKeys` alone, so
// what the API publishes never depends on D1 or on a secret. Public keys only: a private member (`d`) is refused.
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** RFC 7638 thumbprint of a P-256 public JWK: b64url(sha256('{"crv","kty","x","y"}')) (as @hana-id/core jwkThumbprint). */
export function p256Thumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
}

const coord = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'x and y are 32-byte base64url coordinates');
const kid = z.string().regex(/^[A-Za-z0-9_-]{43}$/u, 'A kid is an RFC 7638 thumbprint (43 base64url characters)');

/** A public P-256 key as the JWKS serves it. `.strict()`: a private member (`d`) or anything else is refused. */
export const identityPublicKeySchema = z.object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: coord, y: coord, kid, use: z.literal('sig'), alg: z.literal('ES256') }).strict();

/**
 * Testnet and `local*` only (D121, D127): the private keys are Worker secrets (IDENTITY_SIGNING_KEY and
 * IDENTITY_SIGNING_KEY_STANDBY), and `activeKid` names the one that signs. Switching to the standby key is a manifest
 * change of `activeKid` and a deploy (docs/operations.md "Identity token keys").
 */
const workerSecretSigner = z.object({ kind: z.literal('worker-secret'), activeKid: kid }).strict();

/**
 * A KMS key ARN in the standard partition: `arn:aws:kms:<region>:<account>:key/<key id>`. Single-region keys only (a
 * UUID key id): a multi-region replica (`mrk-…`) shares its primary's key material, so it can't be an independent
 * standby, and an alias could be repointed outside the manifest.
 */
export const KMS_KEY_ARN_RE = /^arn:aws:kms:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The region and account of a KMS key ARN (`KMS_KEY_ARN_RE`), or null. */
export function kmsArnParts(arn: string): { region: string; account: string } | null {
  const m = KMS_KEY_ARN_RE.exec(arn);
  return m ? { region: m[1]!, account: m[2]! } : null;
}

/** One KMS key: its kid (the thumbprint of the public key `GetPublicKey` returns) and its ARN (public data). */
const kmsKey = z.object({ kid, arn: z.string().regex(KMS_KEY_ARN_RE, 'A single-region KMS key ARN (arn:aws:kms:<region>:<account>:key/<uuid>)') }).strict();

/**
 * Mainnet, and staging's rehearsal (build step 7, D215): AWS KMS `ECC_NIST_P256` `SIGN_VERIFY` keys by role. `active`
 * signs; `standby` (another region, D219) is published and ready for a switch; `next` and `previous` exist during a
 * rotation. Each key's region is its ARN's: the Worker calls `kms.<region>.amazonaws.com` for the active key. Only the
 * active key's ARN reaches the Worker (`IDENTITY_KMS_KEY_ARN`). `credentials`: how the Worker authenticates, today
 * always the access key of the dedicated IAM user `iamUser` as two Worker secrets (`IDENTITY_AWS_ACCESS_KEY_ID`,
 * `IDENTITY_AWS_SECRET_ACCESS_KEY`), set by `identity-key <env> kms-put-aws-key` (Workers can't assume an IAM role
 * without another long-lived secret). `standby` is optional only so that the manifest stays valid between a switch to
 * the standby and the new standby's `kms-add` (docs/operations.md "Identity token keys on AWS KMS").
 */
const awsKmsSigner = z
  .object({
    kind: z.literal('aws-kms'),
    credentials: z
      .object({
        kind: z.literal('worker-secret'),
        iamUser: z.string().regex(/^[A-Za-z0-9+=,.@_-]{1,64}$/u, 'An IAM user name'),
      })
      .strict(),
    keys: z.object({ active: kmsKey, standby: kmsKey.optional(), next: kmsKey.optional(), previous: kmsKey.optional() }).strict(),
  })
  .strict();

export type AwsKmsSignerConfig = z.infer<typeof awsKmsSigner>;
export type KmsKeyRole = keyof AwsKmsSignerConfig['keys'];
export const KMS_KEY_ROLES: readonly KmsKeyRole[] = ['active', 'standby', 'next', 'previous'];

export const identityTokenSchema = z
  .object({
    /**
     * The token's `iss`: `{apiUrl}/v1/identity` (D127 Q14: a stable Hana hostname replaces it before partners go live).
     * The JWKS is at `{iss}/jwks.json` and the discovery document at `{iss}/.well-known/openid-configuration`.
     */
    iss: z.string(),
    signer: z.discriminatedUnion('kind', [workerSecretSigner, awsKmsSigner]),
    /** Every key a token may be signed with now (active, standby; next and previous during a rotation): 1–4. */
    publicKeys: z.array(identityPublicKeySchema).min(1).max(4),
  })
  .strict();

export type IdentityTokenConfig = z.infer<typeof identityTokenSchema>;
export type IdentityPublicKey = z.infer<typeof identityPublicKeySchema>;

/** The `iss` an env's API serves (the API answers `/v1/identity/*` under its own URL). */
export const identityIssuerFor = (apiUrl: string): string => `${apiUrl.replace(/\/+$/u, '')}/v1/identity`;

/**
 * Cross-field rules: `iss` is the API's `/v1/identity`; every kid is its key's thumbprint and appears once; the signer
 * names keys in the list; a Worker-secret signer only on testnet (mainnet keys live in KMS, D127 Q4).
 */
export function identityTokenRules(m: { network: string; apiUrl: string }, t: IdentityTokenConfig, ctx: z.RefinementCtx): void {
  const at = (...path: (string | number)[]) => ['identityToken', ...path];
  if (t.iss !== identityIssuerFor(m.apiUrl)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('iss'), message: `identityToken.iss must be ${identityIssuerFor(m.apiUrl)} (the API serves /v1/identity/*)` });
  }
  const kids = new Set<string>();
  t.publicKeys.forEach((k, i) => {
    if (p256Thumbprint(k) !== k.kid) ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('publicKeys', i, 'kid'), message: 'kid must be the key’s RFC 7638 thumbprint' });
    if (kids.has(k.kid)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('publicKeys', i, 'kid'), message: `Duplicate key ${k.kid}` });
    kids.add(k.kid);
  });
  const signer = t.signer;
  const named = signer.kind === 'worker-secret' ? [signer.activeKid] : KMS_KEY_ROLES.flatMap((r) => (signer.keys[r] ? [signer.keys[r].kid] : []));
  for (const k of named) {
    if (!kids.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('signer'), message: `The signer's key ${k} is not in identityToken.publicKeys` });
  }
  if (signer.kind === 'aws-kms') kmsSignerRules(signer, kids, (message) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('signer', 'keys'), message }));
  if (t.signer.kind === 'worker-secret' && m.network !== 'testnet') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('signer', 'kind'), message: 'A Worker-secret identity signing key is testnet only: mainnet uses AWS KMS (D127)' });
  }
}

/**
 * The KMS signer's own rules (D215, D219): one key per role (distinct kids and ARNs), every published key has a role
 * (a key nobody tracks is never published), every key in one AWS account (D121's dedicated account), and the standby
 * in another region than the active key and than `next` (the active key after a switch), so a regional KMS outage
 * leaves a key to switch to.
 */
function kmsSignerRules(s: AwsKmsSignerConfig, published: Set<string>, issue: (message: string) => void): void {
  const keys = KMS_KEY_ROLES.flatMap((r) => (s.keys[r] ? [s.keys[r]] : []));
  const kids = new Set(keys.map((k) => k.kid));
  if (kids.size !== keys.length) issue('Each KMS key role needs its own key (a kid appears in two roles)');
  if (new Set(keys.map((k) => k.arn)).size !== keys.length) issue('Each KMS key role needs its own key (an ARN appears in two roles)');
  for (const kid of published) if (!kids.has(kid)) issue(`Published key ${kid} has no role in identityToken.signer.keys`);
  if (new Set(keys.map((k) => kmsArnParts(k.arn)?.account)).size > 1) issue('Every identity KMS key must be in the same AWS account (D121)');
  const region = (k: { arn: string } | undefined) => (k ? kmsArnParts(k.arn)?.region : undefined);
  if (s.keys.standby && region(s.keys.standby) === region(s.keys.active)) issue('The standby KMS key must be in another region than the active key (D219)');
  // `next` becomes the active key at a switch, so it must not share the standby's region either.
  if (s.keys.standby && s.keys.next && region(s.keys.standby) === region(s.keys.next)) issue('The next KMS key must be in another region than the standby (it becomes the active key, D219)');
}

/**
 * The identity token's files in `.secrets/<env>/` (0600, written by scripts/identity-key.ts; D177). The signing keys
 * are P-256 private JWKs (JSON) by role: `signingKey` signs now (a Worker secret), `standbyKey` is published in the
 * JWKS but kept off the Worker (offline, uploaded only by a switch), `nextKey` is a rotation's incoming key (published,
 * not uploaded), `previousKey` the key a switch replaced (until `retire`). `slots` records which Worker secret slot
 * (`IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`) holds which kid (public data). The sub key is base64 of 32
 * bytes.
 */
export const IDENTITY_SECRET_FILES = {
  signingKey: 'identity-signing-key.json',
  standbyKey: 'identity-signing-key-standby.json',
  nextKey: 'identity-signing-key-next.json',
  previousKey: 'identity-signing-key-previous.json',
  slots: 'identity-slots.json',
  subKey: 'identity-sub-key',
  /**
   * The KMS signer's AWS access key (D215): the JSON `aws iam create-access-key --user-name <iamUser>` prints, written
   * by the operator into this file (0600) and uploaded by `identity-key <env> kms-put-aws-key`. Testnet-style files
   * above don't exist for a KMS signer (its private keys never leave KMS).
   */
  awsAccessKey: 'identity-aws-access-key.json',
  /**
   * The sealed email's key (D419, docs/email-sharing-spec.md): IDENTITY_SEAL_KEY on the API and the email issuer,
   * `<id>:<base64 of 32 bytes>` (`identitySealKeyId`). Written and uploaded by `identity-key <env> email-keys`.
   */
  sealKey: 'identity-seal-key',
  /** The email consents' MAC key (D420): EMAIL_CONSENT_KEY on the API, base64 of 32 bytes. Written with the seal key. */
  emailConsentKey: 'email-consent-key',
} as const;

/** IDENTITY_SEAL_KEY's form, as @hana-id/email `parseSealKey` reads it: `<id>:<base64 of 32 bytes>`, id 1..2^32-1. */
const IDENTITY_SEAL_KEY_RE = /^([1-9]\d{0,9}):([A-Za-z0-9+/]{43}=)$/u;

/** The key id of an IDENTITY_SEAL_KEY value, or null when it isn't one (the value never reaches an error). */
export function identitySealKeyId(value: string): number | null {
  const m = IDENTITY_SEAL_KEY_RE.exec(value);
  if (!m) return null;
  const id = Number(m[1]);
  return id <= 0xffffffff && Buffer.from(m[2]!, 'base64').length === 32 ? id : null;
}
