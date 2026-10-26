// MPC CKD network key lookup.

export interface MpcState {
  Running?: { keyset?: { domains?: { domain_id: number; key?: { Bls12381?: { public_key?: string } } }[] } };
}

/** Picks the domain's BLS12-381 public key out of the MPC `state` view (see legacy/client/mpc.ts ckdNetworkKey). */
export function ckdKeyFromState(state: MpcState, domainId: number): string {
  if (!state.Running) throw new Error(`MPC is not in the Running state (${Object.keys(state).join(', ') || 'unknown'})`);
  const key = state.Running.keyset?.domains?.find((d) => d.domain_id === domainId)?.key?.Bls12381?.public_key;
  if (!key) throw new Error(`The MPC has no BLS12-381 (CKD) key for domain ${domainId}`);
  if (!/^bls12381g2:[1-9A-HJ-NP-Za-km-z]+$/u.test(key)) throw new Error(`Unexpected CKD key format: ${key}`);
  return key;
}
