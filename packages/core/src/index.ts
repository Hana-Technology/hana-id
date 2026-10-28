// @hana-id/core: pure TypeScript (WebCrypto, @noble/*, @scure/base), no DOM, shared by the vault, the auth pages, the
// partner client and the tests. Batch B fills it (docs/batch-b-spec.md, Packages): layouts, CKD, derivation v1
// (`@hana-id/core/derivation`), signers, approval decoders, the ID-token check and the protocol message schemas.

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.0.0';

// Approval decoders, EIP-712 and auto-approve policies (docs/batch-b-spec.md "Approval flow", "Auto-approve policies").
export * from './approval.ts';
export * from './typed-data.ts';
export * from './decode/abi.ts';
export * from './decode/eip712.ts';
export * from './decode/errors.ts';
export * from './decode/evm.ts';
export * from './decode/hex.ts';
export * from './decode/json.ts';
export * from './decode/message.ts';
export * from './decode/request.ts';
export * from './decode/rlp.ts';
export * from './decode/selectors.ts';
export * from './decode/stellar.ts';
export * from './policy/decoders.ts';
export * from './policy/id.ts';
export * from './policy/match.ts';
export * from './policy/types.ts';
export * from './policy/usage.ts';
export * from './policy/validate.ts';
