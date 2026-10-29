// Entry of {authOrigin}/login (built per env by scripts/build-auth-pages.ts).
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { startLoginPage } from '../login-page.ts';

startLoginPage({ win: window, env: BUILD_ENV, api: authApi(BUILD_ENV.apiUrl) });
