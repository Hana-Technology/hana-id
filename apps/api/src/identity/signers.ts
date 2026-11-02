// Picks the identity token's signer from the Worker's configuration (docs/identity-token-spec.md "Where the key
// lives", D215): IDENTITY_SIGNER is `worker-secret` (testnet and `local*`: a P-256 private JWK as a Worker secret,
// signer.ts) or `aws-kms` (mainnet and staging: kms.ts). gen writes it from the manifest's `identityToken.signer.kind`;
// a Worker configured before build step 7 has no IDENTITY_SIGNER and keeps the Worker-secret signer. Either way the
// endpoint only calls `sign` and reads `kid`, and every signature is verified with the published key before a token is
// answered. Every failure is an IdentitySignerError (a reason code), answered as 503 identity_signer_unavailable.
import type { Env } from '../env.ts';
import { KmsIdentitySigner } from './kms.ts';
import { type IdentityConfig, type IdentitySigner, IdentitySignerError, workerSecretSigner } from './signer.ts';

export type IdentitySignerKind = 'worker-secret' | 'aws-kms';

type SignerEnv = Pick<Env, 'IDENTITY_SIGNER' | 'IDENTITY_SIGNING_KEY' | 'IDENTITY_SIGNING_KEY_STANDBY' | 'IDENTITY_KMS_KEY_ARN' | 'IDENTITY_AWS_ACCESS_KEY_ID' | 'IDENTITY_AWS_SECRET_ACCESS_KEY'>;

/** The signer for the configured kind and `config.activeKid`; rejects with IdentitySignerError when it can't be built. */
export async function identitySigner(env: SignerEnv, config: Pick<IdentityConfig, 'activeKid' | 'keys'>): Promise<IdentitySigner> {
  const kind = env.IDENTITY_SIGNER ?? 'worker-secret';
  if (kind === 'worker-secret') return workerSecretSigner(env, config);
  if (kind !== 'aws-kms') throw new IdentitySignerError('unknown_signer_kind');
  const published = config.keys.find((k) => k.kid === config.activeKid);
  if (!published) throw new IdentitySignerError('active_kid_not_published');
  if (!env.IDENTITY_KMS_KEY_ARN) throw new IdentitySignerError('no_kms_key_arn');
  if (!env.IDENTITY_AWS_ACCESS_KEY_ID || !env.IDENTITY_AWS_SECRET_ACCESS_KEY) throw new IdentitySignerError('no_aws_credentials');
  return new KmsIdentitySigner({
    kid: published.kid,
    keyArn: env.IDENTITY_KMS_KEY_ARN,
    published,
    accessKeyId: env.IDENTITY_AWS_ACCESS_KEY_ID,
    secretAccessKey: env.IDENTITY_AWS_SECRET_ACCESS_KEY,
  });
}
