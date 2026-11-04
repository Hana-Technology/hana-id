// The admin console's response headers (docs/batch-c-spec.md "Response headers": the console's and the admin's are the
// same), on every response: the SPA's assets too, since the Worker runs first (`run_worker_first`), its JSON, its 404s
// for another host and its errors. Everything is `'self'`, plus `data:` and the files origin for images; no third-party
// script, style, font, frame or connection. scripts/test/gen-wrangler.test.ts checks this equals the console's CSP.

export function adminCsp(filesOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: ${filesOrigin}`,
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(filesOrigin: string): Record<string, string> {
  return {
    'content-security-policy': adminCsp(filesOrigin),
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
  };
}

/**
 * The response with the security headers set (replacing any it had). `/api/*` answers also get `cache-control:
 * no-store` (they carry staff data, contacts and members). No response of this Worker sets a cookie: Access sets its
 * own `CF_Authorization` at the edge, never through the Worker.
 */
export function withSecurityHeaders(res: Response, filesOrigin: string, opts: { api: boolean }): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(securityHeaders(filesOrigin))) out.headers.set(k, v);
  if (opts.api) out.headers.set('cache-control', 'no-store');
  out.headers.delete('set-cookie');
  return out;
}
