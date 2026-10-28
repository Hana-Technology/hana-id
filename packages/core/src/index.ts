// @hana-id/core: pure TypeScript (WebCrypto, @noble/*, @scure/base), no DOM, shared by the vault, the auth pages, the
// partner client and the tests. Batch B fills it (docs/batch-b-spec.md, Packages): layouts, CKD, derivation v1
// (`@hana-id/core/derivation`), signers, approval decoders, the ID-token check and the protocol message schemas.

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.0.0';

export * from './addresses.ts';
export * from './api-types.ts';
export * from './bytes.ts';
export * from './ckd.ts';
export * from './derivation.ts';
export * from './export.ts';
export * from './id-token.ts';
export * from './layouts.ts';
export * from './protocol.ts';
export * from './relay.ts';
export * from './session.ts';
export * from './signers/eip712.ts';
export * from './signers/evm.ts';
export * from './signers/stellar.ts';
