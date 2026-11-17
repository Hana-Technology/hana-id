// @hana-id/core/evm-sponsor: the pure signing core of sponsored EVM actions (docs/decisions.md D833, D846), where
// Journear's relayer pays the network fee through an EIP-7702 delegate (contracts/evm-delegate). No network access.
// Not in the root entry: only the vault, the approval popup and the API's relayer need it.
export * from './authorization.ts';
export * from './delegates.ts';
export { EvmSponsorError, type EvmSponsorErrorCode } from './errors.ts';
export * from './execute.ts';
export * from './guard.ts';
export * from './subject.ts';
export * from './tx.ts';
