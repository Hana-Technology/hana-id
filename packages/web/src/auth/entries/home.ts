// Entry of {authOrigin}/home (built per env by scripts/build-auth-pages.ts): Hana Home.
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { homeApi } from '../home-api.ts';
import { startHomePage } from '../home-page.ts';

startHomePage({ win: window, env: BUILD_ENV, api: homeApi(BUILD_ENV.apiUrl), relay: authApi(BUILD_ENV.apiUrl) });
