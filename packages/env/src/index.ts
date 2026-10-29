import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Manifest, manifestSchema } from './schema.ts';

export { DO_LOCATION_HINTS, endpointUrlProblem, type Manifest, manifestSchema, MIN_CKD_SOURCES, PAGER_PROVIDERS } from './schema.ts';
export { hanaOriginProblem, isDevEnv, isLocalEnv, isLoopbackHost, LOCALHOST_WILDCARD, partnerOriginProblem, siteOf } from './origins.ts';
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
