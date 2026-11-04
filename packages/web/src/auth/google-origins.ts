// Google's origins the auth pages' CSPs name, with no imports, so the policy module (pages.ts) stays free of the
// pages' code and the API's header-policy test can hold the two policies side by side (apps/api test/pages-host.test.ts).

/** Google's tokeninfo origin: the callback page's connect-src in an env with an email issuer (auth/pages.ts, apps/api pages/host.ts). */
export const GOOGLE_TOKENINFO_ORIGIN = 'https://oauth2.googleapis.com';
