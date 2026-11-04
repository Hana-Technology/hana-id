// CSRF (docs/batch-c-spec.md "Hana admin console": "The console's CSRF rules and CSP apply"): every non-GET request
// needs all four of `Sec-Fetch-Site: same-origin`, `Origin` exactly `admin.origin`, the custom header `x-hana-admin: 1`
// (a cross-site form or `no-cors` fetch can't send it without a preflight, and this Worker answers no CORS preflight)
// and `content-type: application/json`, else 403 `csrf`. Access's `CF_Authorization` cookie is `SameSite=Lax`, so a
// cross-site POST could carry it: these checks are what stop such a request, not the JWT check.

export type CsrfProblem = 'sec-fetch-site' | 'origin' | 'x-hana-admin' | 'content-type';

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function csrfProblem(request: Request, adminOrigin: string): CsrfProblem | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const h = request.headers;
  if (h.get('sec-fetch-site') !== 'same-origin') return 'sec-fetch-site';
  if (h.get('origin') !== adminOrigin) return 'origin';
  if (h.get('x-hana-admin') !== '1') return 'x-hana-admin';
  const type = (h.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return 'content-type';
  return null;
}
