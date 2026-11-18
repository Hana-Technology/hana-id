// Entry of {authOrigin}/email/confirm (built per env by scripts/build-auth-pages.ts; D866). It calls only the email
// issuer (its CSP, pages.ts) and stores nothing.
import { BUILD_ENV } from '../../build-env.ts';
import { startSupportPage, supportApi } from '../support-page.ts';

startSupportPage({ win: window, kind: 'confirm', api: supportApi(BUILD_ENV.emailIssuerUrl), storage: null });
