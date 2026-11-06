// Whether an app has the mainnet demo on (D426), as GET /v1/app serves it and the events endpoint checks it. Its own
// module so handlers.ts can read it without importing mainnet-demo.ts (which imports handlers.ts).
import type { App } from './apps.ts';
import type { Env } from './env.ts';
import { isDevEnv } from './origins.ts';

/** Whether this Worker's env may have the mainnet demo at all: a dev env (`local*`, `sandbox*`) on testnet. */
export const mainnetDemoEnv = (env: Pick<Env, 'ENV_NAME' | 'NETWORK'>): boolean => isDevEnv(env.ENV_NAME) && env.NETWORK === 'testnet';

/**
 * Whether `app` has the mainnet demo on: a dev testnet env, a test scope and the D1 switch. A missing column (migration
 * 0013 not applied) or a failed read is off.
 */
export async function mainnetDemoOn(env: Pick<Env, 'DB' | 'ENV_NAME' | 'NETWORK'>, app: Pick<App, 'id' | 'environment'>): Promise<boolean> {
  if (!mainnetDemoEnv(env) || app.environment !== 'test') return false;
  try {
    const row = await env.DB.prepare('SELECT mainnet_demo FROM apps WHERE id = ?1').bind(app.id).first<{ mainnet_demo: number }>();
    return row?.mainnet_demo === 1;
  } catch {
    return false;
  }
}

