// @hana-id/web: the partner client (`createHana`: vault iframe, handshake, login popup, EIP-1193 provider, Stellar and
// raw signers) and the Hana pages (vault, login, callback, approve, export), built per env from envs.generated.ts.
// Batch B fills it (docs/batch-b-spec.md, Packages and Standard interfaces).

/** SDK version, sent as `sdk` in `hana:hello`; kept equal to package.json (test/index.test.ts). */
export const VERSION = '0.0.0';

export type { HanaEnv } from './hana-env.ts';
