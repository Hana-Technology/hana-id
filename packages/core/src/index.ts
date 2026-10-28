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
export * from './signers/evm.ts';
// The Stellar signers are `@hana-id/core/signers/stellar` only: they pull in @stellar/stellar-base (about 450 kB
// minified), which pages that sign nothing on Stellar (apps/smoke, the login popup) must not bundle.

// Approval subjects and digest, the EIP-712 parser and the strict JSON reader (docs/batch-b-spec.md "Approval flow").
// The decoders and the auto-approve policy code live at `@hana-id/core/decode` and `@hana-id/core/policy`, so this
// entry, which the partner client imports, never pulls in @stellar/stellar-base (test/index.test.ts checks).
export * from './approval.ts';
export * from './typed-data.ts';
export * from './decode/errors.ts';
export * from './decode/json.ts';
// Names two modules both define are exported once, explicitly (an ambiguous `export *` name is silently dropped):
// - EIP-712: typed-data.ts is the single parser, so its TypedDataField and hashTypedData (over NormalizedTypedData) are
//   the root's. signTypedData hashes with signers/eip712.ts, which accepts NormalizedTypedData too
//   (test/eip712-hashers.test.ts checks the two hashers agree); its structural helpers are exported here.
// - EVM addresses: addresses.ts's parseEvmAddress (→ bytes) and isEvmAddress are the root's; decode/hex.ts's string
//   forms stay at `@hana-id/core/decode`.
export { type TypedDataForHashing, domainSeparator, encodeType, hashStruct, typeHash } from './signers/eip712.ts';
export { bytesToBigInt, checksumAddress, parseHex0x, toHex0x } from './decode/hex.ts';
