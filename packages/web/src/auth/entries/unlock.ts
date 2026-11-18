// Entry of {authOrigin}/email/unlock (built per env by scripts/build-auth-pages.ts; D866). It calls only the email
// issuer (its CSP, pages.ts), and keeps the pressed unlock in this origin's localStorage for /login/email.
import { BUILD_ENV } from '../../build-env.ts';
import { startSupportPage, supportApi } from '../support-page.ts';

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

startSupportPage({ win: window, kind: 'unlock', api: supportApi(BUILD_ENV.emailIssuerUrl), storage: localStore() });
