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

/** Mainnet (build step 7): AWS KMS `ECC_NIST_P256` keys by kid. The API doesn't implement it yet; gen refuses it. */
const awsKmsSigner = z
  .object({
    kind: z.literal('aws-kms'),
    awsRegion: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/u, 'An AWS region such as ap-east-1'),
    keys: z.object({ active: kid, standby: kid, next: kid.optional(), previous: kid.optional() }).strict(),
  })
  .strict();

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
  const named = t.signer.kind === 'worker-secret' ? [t.signer.activeKid] : Object.values(t.signer.keys).filter((v): v is string => typeof v === 'string');
  for (const k of named) {
    if (!kids.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('signer'), message: `The signer's key ${k} is not in identityToken.publicKeys` });
  }
  if (t.signer.kind === 'worker-secret' && m.network !== 'testnet') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: at('signer', 'kind'), message: 'A Worker-secret identity signing key is testnet only: mainnet uses AWS KMS (D127)' });
  }
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
} as const;
