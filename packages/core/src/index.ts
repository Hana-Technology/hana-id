// @hana-id/core: pure TypeScript (WebCrypto, @noble/*, @scure/base), no DOM, shared by the vault, the auth pages, the
// partner client and the tests. Batch B fills it (docs/batch-b-spec.md, Packages): layouts, CKD, derivation v1
// (`@hana-id/core/derivation`), signers, approval decoders, the ID-token check and the protocol message schemas.

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.0.0';

// Approval subjects and digest, the EIP-712 parser and the strict JSON reader (docs/batch-b-spec.md "Approval flow").
// The decoders and the auto-approve policy code live at `@hana-id/core/decode` and `@hana-id/core/policy`, so this
// entry, which the partner client imports, never pulls in @stellar/stellar-base (test/index.test.ts checks).
export * from './approval.ts';
export * from './typed-data.ts';
export * from './decode/errors.ts';
export * from './decode/hex.ts';
export * from './decode/json.ts';
