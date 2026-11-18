// The EVM relayer's staff tools (D851), for the admin package to expose later through AdminRpc; no route reaches them.
// Staff only by convention: any holder of the EVM_RELAYER binding could call the object's staff methods, so their guard
// lives here, and a test (scripts/test/evm-relayer-staff.test.ts) keeps every other file in apps/api/src, the
// sponsorship handlers under src/evm/ and the public routes included, from importing this file or naming the guard.
// Each tool re-reads the chain inside the object, refuses unsafe use, and is recorded there (who, when, what, note,
// outcome). What each halt means and which tool resolves it: docs/operations.md "EVM sponsorship relay".
import { EVM_RELAYER_STAFF_GUARD, type EvmRelayer, type EvmRelayerStaffResult, type EvmRelayerStaffStatus } from './evm-relayer.ts';

type Stub = DurableObjectStub<EvmRelayer>;

/** Every record (hashes, no raw transactions), the halt, the day's backstop and the last 50 staff actions. */
export const evmRelayerStaffStatus = (stub: Stub): Promise<EvmRelayerStaffStatus> => stub.staffStatus(EVM_RELAYER_STAFF_GUARD) as Promise<EvmRelayerStaffStatus>;

/** Clears the halt after a fresh check of the chain finds no halt condition; refused while one holds. */
export const evmRelayerStaffResume = (stub: Stub, who: string, note: string): Promise<EvmRelayerStaffResult> => stub.staffResume(EVM_RELAYER_STAFF_GUARD, who, note) as Promise<EvmRelayerStaffResult>;

/** Closes the record at `nonce` as consumed elsewhere: only when the chain's confirmed count is past it and none of its versions has a receipt. */
export const evmRelayerStaffClose = (stub: Stub, who: string, nonce: number, verdict: 'consumed_elsewhere', note: string): Promise<EvmRelayerStaffResult> =>
  stub.staffClose(EVM_RELAYER_STAFF_GUARD, who, nonce, verdict, note) as Promise<EvmRelayerStaffResult>;

/** Signs a 0-value self-transfer at the SAME nonce for a record with no receipt (its earlier versions kept; a nonce is never freed). */
export const evmRelayerStaffCancel = (stub: Stub, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> => stub.staffCancel(EVM_RELAYER_STAFF_GUARD, who, nonce, note) as Promise<EvmRelayerStaffResult>;

/** Sends a 0-value self-transfer at a gap nonce (no record, below nextNonce, the chain's next nonce). */
export const evmRelayerStaffFill = (stub: Stub, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> => stub.staffFill(EVM_RELAYER_STAFF_GUARD, who, nonce, note) as Promise<EvmRelayerStaffResult>;

/** Sets nextNonce to `nonce`, only with nothing unmined and the chain's latest and pending counts both `nonce`. */
export const evmRelayerStaffAdoptNonce = (stub: Stub, who: string, nonce: number, note: string): Promise<EvmRelayerStaffResult> => stub.staffAdoptNonce(EVM_RELAYER_STAFF_GUARD, who, nonce, note) as Promise<EvmRelayerStaffResult>;
