// The routes every browser context of the suite gets (tests/fixtures.ts, its `google` fixture) and the hand-test
// browser gets too (src/hand-test.ts, D880): Google's endpoints answered by the OIDC stub (src/google-stub.ts), the
// foreign site's static page, and live mode's https origins forwarded to the stack (src/stack.ts LIVE_UPSTREAMS). One
// definition, so a person trying the stack by hand meets exactly the routes the tests run with.
import type { APIResponse, BrowserContext, Route } from '@playwright/test';
import { GOOGLE_AUTH_URL, GOOGLE_CERTS_URL, GOOGLE_TOKENINFO_URL, type GoogleStub } from './google-stub.ts';
import { EVIL_ORIGIN, LIVE_UPSTREAMS } from './stack.ts';

/** The page script of a foreign site (EVIL_ORIGIN): never Hana code, served only by a route in the test's context. */
const EVIL_HTML = `<!doctype html><meta charset="utf-8"><title>evil</title><script>
window.received = [];
addEventListener('message', (e) => { window.received.push({ origin: e.origin, t: e.data && e.data.t }); });
</script><h1>evil</h1>`;

/** The part of a context the routes need (a BrowserContext; a recorder in the route-set test, test/hand-browser.test.ts). */
export type RouteTarget = Pick<BrowserContext, 'route'>;

/**
 * Routes Google's endpoints (authorization, JWKS, tokeninfo) to `google`, the foreign site to its static page, and
 * live mode's https origins to the stack (LIVE_UPSTREAMS), in `context`.
 */
export async function routeStubs(context: RouteTarget, google: GoogleStub): Promise<void> {
  await context.route(`${GOOGLE_AUTH_URL}**`, async (route) => route.fulfill(await google.authorize(new URL(route.request().url()))));
  await context.route(GOOGLE_CERTS_URL, async (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }, body: JSON.stringify(await google.jwks()) }),
  );
  // token_first's callback asks tokeninfo from the browser (D270): a form POST, with Google's CORS for the page.
  await context.route(`${GOOGLE_TOKENINFO_URL}**`, async (route) => {
    const r = route.request();
    await route.fulfill(google.tokeninfo(r.method(), (await r.headerValue('origin')) ?? null, r.postData()));
  });
  await context.route(`${EVIL_ORIGIN}/**`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: EVIL_HTML }));
  await context.route((url) => Object.hasOwn(LIVE_UPSTREAMS, url.origin), forwardLive);
}

/**
 * A request to one of live mode's https origins, forwarded to the stack server behind it (as a TLS-terminating front
 * would: method, headers and body unchanged, the server's response, headers included, as is). The servers rewrite the
 * URL back to the https origin (src/server/http.ts servedAt). Long polls (the login relay) take as long as they take.
 */
async function forwardLive(route: Route): Promise<void> {
  const url = new URL(route.request().url());
  const upstream = LIVE_UPSTREAMS[url.origin] as string;
  let response: APIResponse;
  try {
    response = await route.fetch({ url: `${upstream}${url.pathname}${url.search}`, maxRedirects: 0, timeout: 0 });
  } catch {
    // The page went away mid-request (a closed popup, the end of a test).
    await route.abort().catch(() => undefined);
    return;
  }
  await route.fulfill({ response }).catch(() => undefined);
}
