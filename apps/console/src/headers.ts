// The console's response headers (docs/batch-c-spec.md "Response headers"), on every response it sends: the SPA's
// assets too, since the Worker runs first (`run_worker_first`), its JSON, its 404s for another host and its errors.
// No third-party script, style, font, frame or connection: everything is `'self'`, plus `data:` and the files origin
// for images (partner logos). `frame-ancestors 'none'` keeps the console out of every frame (clickjacking of the kill
// switches and of the step-up confirm), `form-action 'self'` keeps a form from posting anywhere else.

/** The CSP, exactly as the spec writes it, with `files.origin` in `img-src`. */
export function consoleCsp(filesOrigin: string): string {
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

/** Every header the spec lists for the console and admin origins. */
export function securityHeaders(filesOrigin: string): Record<string, string> {
  return {
    'content-security-policy': consoleCsp(filesOrigin),
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
  };
}

/**
 * The response with the security headers set (replacing any the response had), and `cache-control: no-store` on
 * `/api/*` answers (they carry org data; nothing between the browser and the Worker may keep them). Responses from
 * the assets binding have immutable headers, so this always builds a new Response.
 */
export function withSecurityHeaders(res: Response, filesOrigin: string, opts: { api: boolean }): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(securityHeaders(filesOrigin))) out.headers.set(k, v);
  if (opts.api) out.headers.set('cache-control', 'no-store');
  // Never set by the console before sign-in exists (C9 sets only its own `__Host-` cookies), and never by an asset.
  if (!opts.api) out.headers.delete('set-cookie');
  return out;
}
