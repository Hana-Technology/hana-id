// @hana-id/core: pure TypeScript (WebCrypto, @noble/*, @scure/base), no DOM, shared by the vault, the auth pages, the
// partner client and the tests. Batch B fills it (docs/batch-b-spec.md, Packages): layouts, CKD, derivation v1
// (`@hana-id/core/derivation`), signers, approval decoders, the ID-token check and the protocol message schemas.

/** Package version, kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.0.0';
