// The vault bundle's entry (served as `/vault.js` on vaultOrigin, apps/api/src/vault/page.ts). It is built per env by
// scripts/build-vault.ts with that env inlined (build-env.ts), so SIGNER, RELAYER, the CKD key and the origins are
// constants of the bundle, never read at runtime.
import { BUILD_ENV } from '../build-env.ts';
import { bootVault } from './boot.ts';

bootVault(window, BUILD_ENV);
