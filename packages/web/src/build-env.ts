// The env a page bundle was built for. scripts/build-auth-pages.ts and scripts/build-vault.ts replace __HANA_ENV__
// with that env's envs.generated.ts entry, so `signer`, `relayer`, `ckdNetworkKey` and the origins are constants in the
// bundle and never read at runtime. Only the entries import this; the page modules take the env as a parameter (tests
// pass their own).
import type { HanaEnv } from './hana-env.ts';

declare const __HANA_ENV__: HanaEnv;

export const BUILD_ENV: HanaEnv = Object.freeze({ ...__HANA_ENV__ });
