// JSON answers of the console's `/api/*` backend (docs/batch-c-spec.md "RpcCode → HTTP status"): a success body, or
// `{error: {code, message}}` with the status the code maps to. Every RpcCode keeps its status from console-core; the
// console-only codes (`csrf`, `unauthenticated`, …) have theirs.
import { CONSOLE_ERROR_STATUS, RPC_HTTP_STATUS, type ConsoleErrorCode, type RpcCode } from '@hana-id/console-core';

export type ErrorCode = RpcCode | ConsoleErrorCode | 'method_not_allowed' | 'payload_too_large' | 'unsupported_media_type';

const EXTRA_STATUS = { method_not_allowed: 405, payload_too_large: 413, unsupported_media_type: 415 } as const;

export function statusOf(code: ErrorCode): number {
  if (code in RPC_HTTP_STATUS) return RPC_HTTP_STATUS[code as RpcCode];
  if (code in CONSOLE_ERROR_STATUS) return CONSOLE_ERROR_STATUS[code as ConsoleErrorCode];
  return EXTRA_STATUS[code as keyof typeof EXTRA_STATUS];
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  csrf: 'The request is missing the console’s same-origin checks',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  payload_too_large: 'The request body is too large',
  rate_limited: 'Too many requests; try again in a minute',
  internal: 'Something went wrong',
};

/** `{error: {code, message}}`. The message is ours, never an upstream error's text (which can echo input). */
export function errorResponse(code: ErrorCode, message?: string, headers: Record<string, string> = {}): Response {
  return json(statusOf(code), { error: { code, message: message ?? MESSAGES[code] ?? code } }, headers);
}

/** The biggest JSON body any session-less route takes (a link confirm is ~100 bytes). */
export const MAX_JSON_BODY = 4096;

/** The cap for a body sent without a Content-Length (chunked): stricter, since nothing was declared up front. */
export const MAX_UNDECLARED_BODY = 1024;

/**
 * The request's body bytes, read as a stream and counted as they arrive: the read stops (and the stream is cancelled)
 * as soon as the count passes the cap, so an oversized body is never buffered whole. A malformed `Content-Length` is
 * `bad_request`; one over `max` is refused before reading, and a body longer than it declared is refused at the
 * declared length. A body with none (chunked) gets the stricter `MAX_UNDECLARED_BODY`.
 */
export async function readBodyCapped(request: Request, max = MAX_JSON_BODY): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; code: ErrorCode }> {
  const header = request.headers.get('content-length');
  let cap: number;
  if (header === null) cap = Math.min(max, MAX_UNDECLARED_BODY);
  else {
    if (!/^\d{1,15}$/u.test(header.trim())) return { ok: false, code: 'bad_request' };
    const declared = Number(header.trim());
    if (declared > max) return { ok: false, code: 'payload_too_large' };
    cap = declared;
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { ok: false, code: 'payload_too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

/** The request's JSON body, at most `max` bytes (readBodyCapped), or an error code. CSRF has already required JSON. */
export async function readJson(request: Request, max = MAX_JSON_BODY): Promise<{ ok: true; value: unknown } | { ok: false; code: ErrorCode }> {
  const body = await readBodyCapped(request, max);
  if (!body.ok) return body;
  const buf = body.bytes;
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)) as unknown };
  } catch {
    return { ok: false, code: 'bad_request' };
  }
}
