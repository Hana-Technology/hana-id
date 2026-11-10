// Entry of {authOrigin}/home/callback (built per env by scripts/build-auth-pages.ts): Hana Home's exit-client callback.
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { runHomeCallbackPage } from '../home-callback-page.ts';

void runHomeCallbackPage({ win: window, authOrigin: BUILD_ENV.authOrigin, api: authApi(BUILD_ENV.apiUrl) });
