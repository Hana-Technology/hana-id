import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateJsonKey } from './json-duplicates.ts';
import { type Manifest, manifestSchema } from './schema.ts';

export { duplicateJsonKey } from './json-duplicates.ts';

export { apiRpcFallbacksOf, ckdSourceOperatorProblems, DO_LOCATION_HINTS, endpointUrlProblem, MAX_API_RPC_FALLBACKS, MAX_CKD_SOURCE_OPERATORS, MAX_OPERATOR_NAME, type Manifest, manifestSchema, MIN_CKD_SOURCES, nearOperatorProblems, nearRelaySchema, operatorConflictProblems, nearSchema, operatorKey, PAGER_PROVIDERS, partnerLabelsProblem } from './schema.ts';
export {
  checksumEvmAddress,
  EVM_SPONSOR_BOUNDS,
  evmSchema,
  evmSponsorChainSchema,
  evmSponsorDelegateProblems,
  evmSponsorPageChains,
  evmSponsorProblems,
  evmSponsorSchema,
  evmSponsorTargetSchema,
  FORBIDDEN_SPONSOR_KEYS,
  isSponsorLoopbackHost,
  sponsorCalldataProblem,
  sponsorDecimalUnits,
  sponsorRpcUrlProblem,
  LOCAL_EVM_CHAIN_IDS,
  OP_STACK_TEST_CHAIN_IDS,
  SPONSOR_TEST_EVM_CHAIN_IDS,
  type EvmSponsor,
  type EvmSponsorChain,
  type EvmSponsorProblem,
  type PinnedSponsorDelegates,
} from './evm-sponsor.ts';
export {
  accessSessionDurationOf,
  accessSessionDurationProblem,
  appChangeDelayProblems,
  DASHBOARD_BLOCKS,
  DEFAULT_ACCESS_SESSION_DURATION,
  DEFAULT_OPS_EVERY_MINUTES,
  emailFromProblem,
  hanaOwnOrigins,
  MAX_APP_CHANGE_DELAY_MS,
  MIN_APP_CHANGE_DELAY_MS,
  PRODUCTION_APP_CHANGE_DELAY_MS,
  neonPlanSchema,
  neonPlanVar,
  opsEveryMinutesOf,
  opsEveryMinutesProblem,
  usersScreenProblem,
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

/** Reads and validates envs/<name>.json (`parseManifest`). */
export function loadEnv(name: string): Manifest {
  return parseManifest(name, readFileSync(manifestPath(name), 'utf8'));
}

/** Validates the text of envs/<name>.json: valid JSON with no key twice in one object (D904), then the schema. */
export function parseManifest(name: string, text: string): Manifest {
  const raw: unknown = JSON.parse(text);
  const duplicate = duplicateJsonKey(text);
  if (duplicate !== null) throw new Error(`envs/${name}.json has a key twice in one object (${duplicate}): JSON keeps only the last, which a reader of the file may not see`);
  const manifest = manifestSchema.parse(raw);
  if (manifest.name !== name) throw new Error(`Manifest ${name}.json declares name "${manifest.name}"`);
  return manifest;
}
