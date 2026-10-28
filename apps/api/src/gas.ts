// Gas attached to each relayed method. All values are TO MEASURE ON TESTNET: they are first estimates
// (docs/batch-a2-shared-client.md), with headroom. Each can be overridden per deployment with a var
// `GAS_<METHOD>_TGAS` (e.g. `GAS_DERIVE_KEY_TGAS=80`), an integer 1..300.
import { log } from './log.ts';
import type { RelayMethod } from './relayer-config.ts';

export const TGAS = 1_000_000_000_000n;
/** NEAR's per-transaction cap. */
export const MAX_TGAS = 300;

/**
 * register_scope verifies one RS256 client proof per client in wasm (up to MAX_CLIENTS = 10; one verification plus
 * session storage measured ~19 Tgas in create_session), so its gas scales with the proof count: base + per proof,
 * capped at MAX_TGAS. Sandbox (integration-tests public_registration_and_timelocked_changes): 10 proofs + 5 OIDC
 * owners burnt 175 Tgas of the 280 attached. TO MEASURE ON TESTNET.
 */
export const REGISTER_SCOPE_BASE_TGAS = 30;
export const REGISTER_SCOPE_PER_PROOF_TGAS = 25;
/** The contract's MAX_CLIENTS. */
export const MAX_CLIENT_PROOFS = 10;
export const registerScopeTgas = (proofs: number): number => Math.min(MAX_TGAS, REGISTER_SCOPE_BASE_TGAS + REGISTER_SCOPE_PER_PROOF_TGAS * Math.max(0, proofs));

/**
 * Defaults in Tgas. derive_key forwards 20 Tgas to the MPC (yield/resume) and needs ≥ 50 attached;
 * create_session_and_derive is both in one receipt (docs/batch-b-spec.md). register_scope's
 * entry is its worst case, registerScopeTgas(MAX_CLIENT_PROOFS); gasFor scales it to the call's actual proof count.
 * Values stay numeric literals: contracts/integration-tests parses this table.
 */
export const DEFAULT_GAS_TGAS: Readonly<Record<RelayMethod, number>> = {
  create_session: 50,
  create_session_and_derive: 100,
  derive_key: 60,
  revoke_session: 20,
  prune_sessions: 50,
  propose_change: 50,
  cancel_change: 50,
  remove_client: 50,
  disable_shared_login: 50,
  execute_change: 50,
  register_scope: 280,
  apply_pending_config: 50,
};

export const gasEnvVar = (method: string): string => `GAS_${method.toUpperCase()}_TGAS`;

const warned = new Set<string>();

/**
 * Gas for `method`: the env override when it is a valid integer 1..300 Tgas, else the default (for register_scope,
 * scaled to `args.client_proofs` when given).
 */
export function gasFor(method: RelayMethod, vars: object, args?: Record<string, unknown>): bigint {
  const name = gasEnvVar(method);
  const raw = (vars as Record<string, unknown>)[name];
  if (raw !== undefined && raw !== '') {
    const tgas = Number(raw);
    if (Number.isInteger(tgas) && tgas >= 1 && tgas <= MAX_TGAS) return BigInt(tgas) * TGAS;
    if (!warned.has(name)) {
      warned.add(name);
      log({ event: 'gas_override_ignored', method, code: 'invalid_gas_override' }, 'warn');
    }
  }
  if (method === 'register_scope' && Array.isArray(args?.client_proofs)) return BigInt(registerScopeTgas(args.client_proofs.length)) * TGAS;
  return BigInt(DEFAULT_GAS_TGAS[method]) * TGAS;
}
