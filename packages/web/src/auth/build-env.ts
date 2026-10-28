// The env an auth-page bundle was built for. scripts/build-auth-pages.ts replaces __HANA_ENV__ with that env's
// envs.generated.ts entry, so `signer`, `relayer` and `ckdNetworkKey` are constants in the bundle and never read at
// runtime. Only the entries import this; the page modules take the env as a parameter (tests pass their own).
import type { HanaEnv } from '../hana-env.ts';

declare const __HANA_ENV__: HanaEnv;

export const BUILD_ENV: HanaEnv = Object.freeze({ ...__HANA_ENV__ });
