// Entry of {authOrigin}/approve (built per env by scripts/build-auth-pages.ts).
import { BUILD_ENV } from '../../build-env.ts';
import { startApprovePage } from '../approve-page.ts';

startApprovePage({ win: window, env: BUILD_ENV });
