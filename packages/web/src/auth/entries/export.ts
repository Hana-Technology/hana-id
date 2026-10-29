// Entry of {authOrigin}/export (built per env by scripts/build-auth-pages.ts).
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { startExportPage } from '../export-page.ts';
import { nearReader } from '../near-rpc.ts';

startExportPage({ win: window, env: BUILD_ENV, api: authApi(BUILD_ENV.apiUrl), near: nearReader(BUILD_ENV) });
