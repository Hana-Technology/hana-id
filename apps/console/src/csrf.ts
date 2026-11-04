// CSRF (docs/batch-c-spec.md "Sessions"): every non-GET request needs all four of
//   - `Sec-Fetch-Site: same-origin` (set by the browser; a page can't forge it),
//   - `Origin` exactly `console.origin`,
//   - `x-hana-console: 1` (a custom header: a cross-site form or `no-cors` fetch can't send it without a preflight, and
//     the console answers no CORS preflight),
//   - `content-type: application/json` (no simple-request body type), except the logo upload's raw image body
//     (`POST /api/orgs/:org/apps/:app/logo`, batch C11), which is exactly `application/octet-stream`: not a
//     simple-request type either, so a cross-site page still can't send it without a preflight,
// else 403 `csrf`. With `SameSite=Strict` session cookies (C9) that is defence in depth: any one of them stops a
// cross-site write. The emailed-link confirms carry no session but run under the same rules, so a mail scanner or a
// cross-site page can't confirm a cancel (a GET never cancels).

/** Which check failed (for tests and logs; the response says only `csrf`). */
export type CsrfProblem = 'sec-fetch-site' | 'origin' | 'x-hana-console' | 'content-type';

/** Methods that never change anything here and need no CSRF check. */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** The logo upload's path (the only route whose body isn't JSON). */
export const LOGO_UPLOAD_PATH_RE = /^\/api\/orgs\/org_[A-Za-z0-9]{1,64}\/apps\/app_[A-Za-z0-9]{1,64}\/logo$/u;

/** The body type a non-GET request to `pathname` must declare. */
export const bodyTypeFor = (pathname: string): string => (LOGO_UPLOAD_PATH_RE.test(pathname) ? 'application/octet-stream' : 'application/json');

export function csrfProblem(request: Request, consoleOrigin: string): CsrfProblem | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const h = request.headers;
  if (h.get('sec-fetch-site') !== 'same-origin') return 'sec-fetch-site';
  if (h.get('origin') !== consoleOrigin) return 'origin';
  if (h.get('x-hana-console') !== '1') return 'x-hana-console';
  // The media type alone (a `; charset=utf-8` parameter is allowed), compared without case as RFC 9110 says.
  const type = (h.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== bodyTypeFor(new URL(request.url).pathname)) return 'content-type';
  return null;
}
