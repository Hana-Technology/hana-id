// JSON responses and CORS headers.

export type Headers_ = Record<string, string>;

export function json(status: number, body: unknown, headers: Headers_ = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** CORS for an origin that has been checked against an app (or `*` for the open endpoints). */
export function corsHeaders(origin: string | '*', allowHeaders: string): Headers_ {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': allowHeaders,
    'access-control-expose-headers': 'x-request-id, retry-after',
    'access-control-max-age': '600',
    ...(origin === '*' ? {} : { vary: 'Origin' }),
  };
}

/**
 * Reads a JSON body up to `max` bytes. The body is streamed and reading stops as soon as it passes `max`, so a
 * chunked body (no Content-Length) or one with a false Content-Length is never buffered beyond the limit.
 */
export async function readJson(request: Request, max: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const tooLarge = { ok: false as const, status: 413, error: 'Body too large' };
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= max)) return tooLarge;
  const bytes = new Uint8Array(max);
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Body must be JSON' };
  }
}
