import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, manifestSchema } from './schema.ts';

export { apiRpcFallbacksOf, DO_LOCATION_HINTS, endpointUrlProblem, MAX_API_RPC_FALLBACKS, type Manifest, manifestSchema, MIN_CKD_SOURCES, PAGER_PROVIDERS } from './schema.ts';
export {
  appChangeDelayProblems,
  DASHBOARD_BLOCKS,
  emailFromProblem,
  hanaOwnOrigins,
  MAX_APP_CHANGE_DELAY_MS,
  MIN_APP_CHANGE_DELAY_MS,
  PRODUCTION_APP_CHANGE_DELAY_MS,
} from './dashboard.ts';
export {
  EMAIL_ISSUER_SECRET_FILES,
  EMAIL_KEY_MAX_BITS,
  EMAIL_KEY_MIN_BITS,
  EMAIL_SENDERS,
  emailIssuerFor,
  emailIssuerSchema,
  emailIssuerUrl,
  emailJwksUrl,
  emailPublicKeySchema,
  workersDevIssuerUrl,
  rsaJwkThumbprint,
  rsaModulusBits,
  type EmailIssuerConfig,
  type EmailPublicKey,
} from './email-issuer.ts';
export { IDENTITY_SECRET_FILES, identitySealKeyId, KMS_KEY_ARN_RE, KMS_KEY_ROLES, identityIssuerFor, identityPublicKeySchema, identityTokenSchema, kmsArnParts, p256Thumbprint, type AwsKmsSignerConfig, type IdentityPublicKey, type IdentityTokenConfig, type KmsKeyRole } from './identity.ts';
export { accountIdFields, CLOUDFLARE_ACCOUNT_ID_RE, customDomainPlacement } from './cloudflare.ts';
export { dnsNameProblem, ENV_ALERT_LABELS, type EnvAlertLabel, envAlertLabel, hanaOriginProblem, isDevEnv, isLocalEnv, isLoopbackHost, LOCALHOST_WILDCARD, partnerOriginProblem, siteOf } from './origins.ts';
export {
  type DelayValues,
  governanceDelayProblems,
  MAINNET_GOVERNANCE_DELAY_MS,
  MIN_GOVERNANCE_DELAY_MS,
  MIN_ISSUER_KEY_DELAY_MS,
  TX_LANDING_MS,
  WATCHDOG_INTERVAL_MS,
} from './delays.ts';

/** Repo root (packages/env/src → ../../..). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function manifestPath(name: string): string {
  if (!/^[a-z0-9-]+$/u.test(name)) throw new Error(`Invalid environment name: ${name}`);
  return join(repoRoot, 'envs', `${name}.json`);
}

/** Reads and validates envs/<name>.json. */
export function loadEnv(name: string): Manifest {
  const raw: unknown = JSON.parse(readFileSync(manifestPath(name), 'utf8'));
  const manifest = manifestSchema.parse(raw);
  if (manifest.name !== name) throw new Error(`Manifest ${name}.json declares name "${manifest.name}"`);
  return manifest;
}
