// JSON responses, CORS and size-capped body reads (requests and provider responses).

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const error = (status: number, code: string, message: string, data?: Record<string, unknown>, headers: Record<string, string> = {}): Response =>
  json(status, { error: message, code, ...(data ? { data } : {}) }, headers);

/** CORS for one checked origin (or `*` for the public key documents). No credentials: the issuer never sets cookies (D70). */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': origin === '*' ? 'GET, OPTIONS' : 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    ...(origin === '*' ? {} : { vary: 'Origin' }),
  };
}

export class TooLarge extends Error {}

/**
 * Reads a stream up to `max` bytes; reading stops as soon as it passes `max` (a chunked body or a false
 * Content-Length is never buffered beyond the limit). Throws TooLarge.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, declared: string | null = null): Promise<Uint8Array> {
  if (declared !== null && !(Number(declared) <= max)) {
    await body?.cancel().catch(() => undefined);
    throw new TooLarge();
  }
  const out = new Uint8Array(max);
  let size = 0;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        throw new TooLarge();
      }
      out.set(value, size);
      size += value.byteLength;
    }
  }
  return out.subarray(0, size);
}

/** A request's JSON body, at most `max` bytes. */
export async function readJson(request: Request, max: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; message: string }> {
  let bytes: Uint8Array;
  try {
    bytes = await readCapped(request.body, max, request.headers.get('content-length'));
  } catch {
    return { ok: false, status: 413, message: 'Body too large' };
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'Body must be JSON' };
  }
}

/** A provider response's body as text, at most `max` bytes (null when larger or unreadable). Never logged. */
export async function responseText(res: Response, max: number): Promise<string | null> {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await readCapped(res.body, max, res.headers.get('content-length')));
  } catch {
    return null;
  }
}

/** A provider response's JSON body, at most `max` bytes, or null. */
export async function responseJson(res: Response, max: number): Promise<unknown> {
  const text = await responseText(res, max);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Exactly these keys (optional ones may be absent). */
export function onlyKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((k) => k in o) && Object.keys(o).every((k) => allowed.has(k));
}
