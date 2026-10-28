// The public entry point: createHana(config) resolves `environment` to its Hana origins from envs.generated.ts (built
// from envs/<name>.json, so a partner can't point the client at another vault by config) and mounts the client.
import { HanaClient, type HanaConfig, warnPartnerIssues } from './client/client.ts';
import { HANA_ENVS } from './envs.generated.ts';

/** The env names this build knows (manifests that set vaultOrigin and authOrigin). */
export const HANA_ENVIRONMENTS: readonly string[] = Object.freeze(Object.keys(HANA_ENVS));

export function createHana(config: HanaConfig): HanaClient {
  const name = (config as Partial<HanaConfig> | null)?.environment;
  const env = typeof name === 'string' && Object.hasOwn(HANA_ENVS, name) ? HANA_ENVS[name] : undefined;
  if (!env) throw new TypeError(`Unknown Hana environment ${JSON.stringify(name)} (known: ${HANA_ENVIRONMENTS.join(', ') || 'none'})`);
  if (typeof window === 'undefined') throw new Error('createHana runs in a browser page');
  warnPartnerIssues(window);
  return new HanaClient(config, {
    win: window,
    origins: { vaultOrigin: env.vaultOrigin, authOrigin: env.authOrigin },
    fetch: (input, init) => fetch(input, init),
  });
}
