// Entry of {authOrigin}/login (built per env by scripts/build-auth-pages.ts). The page makes no API call (D77).
import { BUILD_ENV } from '../../build-env.ts';
import { startLoginPage } from '../login-page.ts';

startLoginPage({ win: window, env: BUILD_ENV });
