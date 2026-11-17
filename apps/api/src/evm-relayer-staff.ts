// The EVM relayer's staff operation (D837): `staffReconcile`, for the admin package to call through AdminRpc. Staff
// only by convention: any holder of the EVM_RELAYER binding could call the method, so its guard lives here and the
// sponsorship handlers (apps/api/src/evm/sponsor*.ts) never import this file (test/evm-relayer.test.ts checks). It does
// only what the object's alarm does in time.
import { EVM_RELAYER_STAFF_GUARD, type EvmRelayer, type EvmRelayerReconcileReport } from './evm-relayer.ts';

export { EVM_RELAYER_STAFF_GUARD };

/** Re-reads the chain through the object and repairs what the alarm would (a gap at once with `fillGapsNow`). */
export function staffReconcileEvmRelayer(stub: DurableObjectStub<EvmRelayer>, opts: { fillGapsNow?: boolean } = {}): Promise<EvmRelayerReconcileReport> {
  return stub.staffReconcile(EVM_RELAYER_STAFF_GUARD, opts) as Promise<EvmRelayerReconcileReport>;
}
