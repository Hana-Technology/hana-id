// hana-signer interface as the scripts use it (method names and JSON shapes per docs/batch-a-spec.md).
import type { NearRpc } from './near.ts';

/** Methods the relayer's function-call keys may call on the signer (spec: deploy-contract). */
export const RELAYER_METHODS = [
  'create_session',
  'derive_key',
  'revoke_session',
  'prune_sessions',
  'register_scope',
  'propose_change',
  'cancel_change',
  'remove_client',
  'execute_change',
] as const;

/** Methods the keys-updater function-call key (on the signer account itself) may call. */
export const KEYS_UPDATER_METHODS = ['set_issuer_key', 'remove_issuer_key'] as const;

export const GOOGLE_PROVIDER = 'google';
export const GOOGLE_ISS_VALUES = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GLOBAL_SCOPE = 'global';

/** Owner JSON form (serde externally tagged). */
export type Owner = { Near: { account_id: string } } | { Oidc: { provider: string; sub: string } };

export interface ContractConfig {
  owner?: string;
  mpc?: string;
  ckd_domain_id?: number;
  console_audiences?: [string, string][];
  sponsors?: string[];
  change_delay_ms?: number;
  public_registration?: boolean;
}

export interface IssuerView {
  iss_values: string[];
  kids: string[];
}

/** Normalises `get_issuer` output: tolerates `{iss_values, kids}`, `{keys: {kid: …}}` or a plain kid array. */
export function normaliseIssuer(raw: unknown): IssuerView | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return { iss_values: [], kids: raw.filter((k): k is string => typeof k === 'string') };
  if (typeof raw !== 'object') throw new Error(`Unexpected get_issuer result: ${JSON.stringify(raw)}`);
  const o = raw as { iss_values?: unknown; kids?: unknown; keys?: unknown };
  const iss = Array.isArray(o.iss_values) ? o.iss_values.filter((v): v is string => typeof v === 'string') : [];
  let kids: string[] = [];
  if (Array.isArray(o.kids)) kids = o.kids.filter((k): k is string => typeof k === 'string');
  else if (Array.isArray(o.keys)) kids = o.keys.filter((k): k is string => typeof k === 'string');
  else if (o.keys && typeof o.keys === 'object') kids = Object.keys(o.keys);
  return { iss_values: iss, kids };
}

/** View helpers that return null when the contract isn't deployed/initialised or the item doesn't exist. */
export async function tryView<T>(rpc: Pick<NearRpc, 'view'>, account: string, method: string, args: unknown = {}): Promise<T | null> {
  try {
    return await rpc.view<T>(account, method, args);
  } catch (err) {
    const msg = (err as Error).message;
    if (/CodeDoesNotExist|MethodNotFound|MethodResolveError|not initialized|NotInitialized|does not exist|Smart contract panicked/u.test(msg)) return null;
    throw err;
  }
}

export const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
export const samePairs = (a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]) =>
  sameSet(
    a.map((p) => JSON.stringify(p)),
    b.map((p) => JSON.stringify(p)),
  );
