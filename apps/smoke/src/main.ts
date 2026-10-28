// Entry of the vault smoke page (index.html): the real partner client from @hana-id/web. The logic is in vault-page.ts.
import { HANA_ENVIRONMENTS, createHana } from '@hana-id/web';
import { startVaultPage } from './vault-page.ts';

startVaultPage({ env: __HANA_SMOKE_ENV__, environments: HANA_ENVIRONMENTS, createClient: createHana });
