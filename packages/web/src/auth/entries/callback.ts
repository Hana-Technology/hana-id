// Entry of {authOrigin}/login/callback (built per env by scripts/build-auth-pages.ts).
import { authApi } from '../api.ts';
import { BUILD_ENV } from '../build-env.ts';
import { runCallbackPage } from '../callback-page.ts';

void runCallbackPage({ win: window, api: authApi(BUILD_ENV.apiUrl) });
