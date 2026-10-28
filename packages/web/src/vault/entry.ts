// The vault bundle's entry (served as `/vault.js` on vaultOrigin, apps/api/src/vault/page.ts). It is built once per
// env with `__HANA_ENV__` replaced by the env name at build time (a bundler `define`), so SIGNER, RELAYER, the CKD key
// and the origins are constants of the bundle, never read at runtime.
import { HANA_ENVS } from '../envs.generated.ts';
import { bootVault } from './boot.ts';

declare const __HANA_ENV__: string;

const env = HANA_ENVS[__HANA_ENV__];
if (env) bootVault(window, env);
