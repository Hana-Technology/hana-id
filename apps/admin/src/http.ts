// JSON answers of the admin's `/api/*` backend (docs/batch-c-spec.md "RpcCode → HTTP status"): a success body, or
// `{error: {code, message}}` with the status the code maps to. RpcCodes keep their console-core status; the admin's own
// codes (the Access check, CSRF, the transport) have theirs below.
import { RPC_HTTP_STATUS, type RpcCode } from '@hana-id/console-core';

/** Codes only the admin BFF answers. */
export const ADMIN_ERROR_STATUS = {
  /** No Access JWT, or one that fails a check (signature, `kid`, `iss`, `aud`, expiry, `type`, `sub`, `email`). */
  unauthenticated: 401,
  /** A valid Access identity whose email isn't on the manifest's staff list (D88). */
  not_staff: 403,
  csrf: 403,
  /** The Access check can't run: the team's certs are unreachable, or the Worker's Access config is missing. */
  access_unavailable: 503,
  /** A Worker this one calls (API or console) didn't answer. */
  upstream_unavailable: 503,
  /** The usage ledger (USAGE_DB) isn't bound or didn't answer (C12's reports, statements, rates and exports). */
  ledger_unavailable: 503,
  method_not_allowed: 405,
  payload_too_large: 413,
  /** The watchdog (batch C14): no WATCHDOG_URL or WATCHDOG_STATUS_TOKEN in this Worker, or the watchdog has none. */
  watchdog_unconfigured: 503,
  /** It didn't answer (network), or answered 5xx. */
  watchdog_unavailable: 502,
  /** It took longer than the timeout (watchdog.ts WATCHDOG_TIMEOUT_MS), body included. */
  watchdog_timeout: 504,
  /** Its answer was bigger than the cap for that route (watchdog.ts WATCHDOG_LIMITS). */
  watchdog_too_large: 502,
  /** Its answer wasn't JSON of the expected shape, or was a redirect (never followed). */
  watchdog_bad_answer: 502,
  /** It refused this Worker's bearer token: the two copies of WATCHDOG_STATUS_TOKEN differ. */
  watchdog_unauthorized: 502,
  /** The alert was acknowledged already (the first ack is kept). */
  already_acknowledged: 409,
  /** The Users screen (C8b): no ISSUER binding, the issuer didn't answer, or its own Access check can't run. */
  directory_unavailable: 503,
  /** The issuer refused a staff identity this Worker accepted: its ADMIN_ACCESS_AUD or staff list differs from this one's. */
  directory_refused: 502,
} as const;
export type AdminErrorCode = keyof typeof ADMIN_ERROR_STATUS;
export type ErrorCode = RpcCode | AdminErrorCode;

export function statusOf(code: ErrorCode): number {
  if (code in ADMIN_ERROR_STATUS) return ADMIN_ERROR_STATUS[code as AdminErrorCode];
  return RPC_HTTP_STATUS[code as RpcCode] ?? 500;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  unauthenticated: 'Sign in through Cloudflare Access',
  not_staff: 'This account is not on the Hana staff list',
  csrf: 'The request is missing the admin console’s same-origin checks',
  access_unavailable: 'The Access check is unavailable; try again shortly',
  upstream_unavailable: 'A Hana service did not answer; try again shortly',
  ledger_unavailable: 'The usage ledger is unavailable; try again shortly',
  not_found: 'Not found',
  method_not_allowed: 'Method not allowed',
  payload_too_large: 'The request body is too large',
  internal: 'Something went wrong',
  watchdog_unconfigured: 'The watchdog is not configured for this admin Worker (WATCHDOG_URL, WATCHDOG_STATUS_TOKEN)',
  watchdog_unavailable: 'The watchdog did not answer',
  watchdog_timeout: 'The watchdog took too long to answer',
  watchdog_too_large: 'The watchdog’s answer was larger than the admin Worker accepts',
  watchdog_bad_answer: 'The watchdog’s answer was not what the admin Worker expects',
  watchdog_unauthorized: 'The watchdog refused the admin Worker’s status token (the two copies differ)',
  already_acknowledged: 'This alert was acknowledged already',
  directory_unavailable: 'The user directory (the email issuer) is unavailable in this environment or did not answer',
  directory_refused: 'The email issuer refused this staff identity: its admin Access config (ADMIN_ACCESS_AUD, ADMIN_STAFF_EMAILS) differs from the admin Worker’s',
};

/** `{error: {code, message}}`. An upstream `error` text is ours (the RPCs write their own messages, never input). */
export function errorResponse(code: ErrorCode, message?: string, headers: Record<string, string> = {}): Response {
  return json(statusOf(code), { error: { code, message: (message ?? MESSAGES[code] ?? code).slice(0, 500) } }, headers);
}

/** The biggest JSON body a staff route takes (a policy is the largest, well under this). */
export const MAX_JSON_BODY = 64 * 1024;
/** A body sent without a Content-Length (chunked) gets this stricter cap. */
export const MAX_UNDECLARED_BODY = 16 * 1024;

/**
 * The request's JSON body, read as a stream and counted as it arrives (as the console's readBodyCapped): a declared
 * length over the cap is refused unread, a longer body than declared is cut off at the declared length.
 */
export async function readJson(request: Request, max = MAX_JSON_BODY): Promise<{ ok: true; value: unknown } | { ok: false; code: ErrorCode }> {
  const header = request.headers.get('content-length');
  let cap: number;
  if (header === null) cap = Math.min(max, MAX_UNDECLARED_BODY);
  else {
    if (!/^\d{1,15}$/u.test(header.trim())) return { ok: false, code: 'bad_request' };
    const declared = Number(header.trim());
    if (declared > max) return { ok: false, code: 'payload_too_large' };
    cap = declared;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
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
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  if (total === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, code: 'bad_request' };
  }
}
