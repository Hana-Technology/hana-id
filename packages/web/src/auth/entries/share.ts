// Entry of {authOrigin}/share-email (built per env by scripts/build-auth-pages.ts; D411).
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { startSharePage } from '../share-page.ts';

startSharePage({ win: window, env: BUILD_ENV, api: authApi(BUILD_ENV.apiUrl) });
