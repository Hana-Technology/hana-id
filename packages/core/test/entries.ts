// Every public export of @hana-id/core, from its three entries (root, `/decode`, `/policy`), for the tests.
export * from '../src/decode/index.ts';
export * from '../src/index.ts';
export * from '../src/policy/index.ts';
// Names the root and `/decode` both export with different meanings: these tests read the decoders' forms (the
// root's byte-returning parseEvmAddress and its RLP encoder's item type are tested through their own modules).
export { type RlpItem, isEvmAddress, parseEvmAddress } from '../src/decode/index.ts';
