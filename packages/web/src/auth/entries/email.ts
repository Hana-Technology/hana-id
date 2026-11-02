// Entry of {authOrigin}/login/email (built per env by scripts/build-auth-pages.ts). It calls only the email issuer and
// the API's relay (its CSP, pages.ts).
import { BUILD_ENV } from '../../build-env.ts';
import { authApi } from '../api.ts';
import { emailApi } from '../email-api.ts';
import { startEmailPage } from '../email-page.ts';

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

if (BUILD_ENV.emailIssuerUrl) {
  startEmailPage({ win: window, env: BUILD_ENV, issuer: emailApi(BUILD_ENV.emailIssuerUrl), api: authApi(BUILD_ENV.apiUrl), tickets: localStore() });
} else {
  // No email issuer in this env: the page explains and stops (its issuer client is never built).
  startEmailPage({ win: window, env: BUILD_ENV, issuer: emailApi(BUILD_ENV.apiUrl), api: authApi(BUILD_ENV.apiUrl), tickets: null });
}
