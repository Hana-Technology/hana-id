// Entry of {authOrigin}/approve (built per env by scripts/build-auth-pages.ts).
import { startApprovePage } from '../approve-page.ts';
import { BUILD_ENV } from '../build-env.ts';

startApprovePage({ win: window, env: BUILD_ENV });
