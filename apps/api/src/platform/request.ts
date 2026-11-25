// The platform API's request authentication and admission (D927; docs/partner-platform-spec.md A3 "The request", A5,
// A7 `platform_calls`, L7; findings M2, M3, M4, L1, L2, L5, L8). Every `/v1/platform…` request goes through these
// checks in this order, failing closed:
//
//   1. Per IP, requests not admitted: a `hit` on `platform:ip:<ipSubject>` (30 a minute, not pinned), given back once
//      the request is admitted (after 8), so only failures and refusals use it. When that window is full the request
//      is still checked, under one shared overflow window (`platform:ip-overflow`, 120 a minute across every IP,
//      pinned), so a valid key behind an IP someone else is failing from is still admitted (M2). Both full: 429.
//   2. An `Origin` header: 403 browser_refused, with no CORS header (never for browsers).
//   3. The shapes, each matched in full, before any signature work: GET or POST (405); the one parsed path and query
//      (400); a known route and its method (404, 405); every header together at most 16 KiB; a GET with no body, no
//      content type and no encoding, a POST with `application/json`, no `content-encoding` and at most 16 KiB (400);
//      `Idempotency-Key`'s form (400); the four `Journear-*` headers (401 unauthenticated).
//   4. The timestamp within ±60 s of the API's clock: else 400 stale_request with `serverTimeMs` only.
//   5. One D1 read: the key by its id, in force here (KEY_IN_FORCE: announced, its date passed, unexpired, not
//      revoked) with its org's switch row; the body read (16 KiB at most) and hashed; the signature verified with
//      WebCrypto's plain ES256 over the canonical message (console-core `platformRequestMessage`: this env's ENV_NAME
//      and SIGNER_ACCOUNT, the method, the path and query, the key id, the timestamp, the nonce, the Idempotency-Key,
//      the body's sha256). An unknown, stopped, expired or not yet active key is verified against a fixed dummy key, so
//      every failure of 5 costs the same work and answers the same 401 (body and headers byte for byte).
//   6. The org's platform switch on (403 platform_off) and the org not frozen (403 forbidden), as the API's mirror
//      `platform_orgs` says (the freeze mirror lags a console freeze by up to about an hour when its write fails:
//      D918). The self-revoke is allowed either way (L5).
//   7. The nonce, reserved until timestamp + 120 s on `platform-nonce:<keyId>` (pinned): a second use is 409
//      request_replayed; more than 300 fresh nonces a minute for one key is 429.
//   8. The key's own windows (`platform:key:<keyId>`, pinned: 60 a minute, 2 000 a UTC day) and the org's hot-DB bucket
//      under the console's global one, with the platform's own destructive-call breaker (`platform:…` keys on the
//      `console-rpc` object, M3). The self-revoke skips them: it can succeed once per key.
//
// Only then is the body parsed and the route run, within PLATFORM_DB_LIMITS, and the call written to `platform_calls`
// (with, at most once an hour per key, `last_used_at`). A limiter that errors is 503 rate_limiter_unavailable; for the
// self-revoke it is logged at error level and the stop goes ahead (a replayed stop can only stop the same key).
import {
  PLATFORM_BODY_MAX,
  PLATFORM_CLOCK_SKEW_MS,
  PLATFORM_CONTENT_TYPE_RE,
  PLATFORM_HEADERS,
  PLATFORM_HEADERS_MAX,
  PLATFORM_HEADER_RES,
  PLATFORM_NONCE_HOLD_MS,
  PLATFORM_PATH_RE,
  PLATFORM_QUERY_RE,
  PLATFORM_REQUEST_LIMITS,
  type PlatformErrorCode,
  PLATFORM_ERROR_STATUS,
  RPC_HTTP_STATUS,
  type RpcCode,
  bodySha256Hex,
  platformRequestMessage,
  signatureBytes,
  utf8,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { json } from '../http.ts';
import { ipSubject } from '../ip.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { ConsoleAdmission, Limit, RateLimiter } from '../rate-limiter.ts';
import { RpcRefusal } from '../changes/cas.ts';
import { HotDb, PLATFORM_DB_LIMITS } from '../changes/db.ts';
import { CONSOLE_LIMITS, CONSOLE_LIMITER, HOUR_MS, eventId } from '../changes/guard.ts';
import { q } from '../changes/sql.ts';
import { KEY_IN_FORCE } from './keys.ts';
import { PLATFORM_ROUTES, type PlatformRoute, type RouteAnswer } from './routes.ts';

export const PLATFORM_PREFIX = '/v1/platform';
/** Whether the router hands a path to the platform API (anything under the prefix, so a malformed one is its 400). */
export const isPlatformPath = (pathname: string): boolean => pathname.startsWith(PLATFORM_PREFIX);

const MIN = 60_000;
const DAY = 24 * HOUR_MS;
const L = PLATFORM_REQUEST_LIMITS;
export const PLATFORM_WINDOWS = {
  /** Requests not admitted, per IP (check 1). */
  ip: [{ name: 'fail:minute', windowMs: MIN, max: L.failuresPerIpPerMinute }],
  /** Requests checked while their IP's window was full, across every IP (check 1, M2). */
  overflow: [{ name: 'overflow:minute', windowMs: MIN, max: L.overflowPerMinute }],
  /** Fresh nonces per key (check 7: the nonce object's size bound). */
  nonce: [{ name: 'nonce:minute', windowMs: MIN, max: L.noncesPerKeyPerMinute }],
  /** Requests admitted per key (check 8). */
  key: [
    { name: 'req:minute', windowMs: MIN, max: L.perKeyPerMinute },
    { name: 'req:day', windowMs: DAY, max: L.perKeyPerDay },
  ],
  /** Failed signatures for a known key id: the 10th in a minute raises `platform_auth_failures`. */
  authFailures: [{ name: 'authfail:minute', windowMs: MIN, max: L.authFailuresAlert - 1 }],
} as const satisfies Record<string, Limit[]>;

/**
 * The platform's admission on the `console-rpc` object (A5): its own org bucket under the console's global one (the
 * same global bucket and reserve, CONSOLE_LIMITS.global), its own breaker (10 per org, 30 across orgs an hour).
 */
export const PLATFORM_LIMITS = {
  perOrg: { ratePerS: 5, burst: 40, reserve: 10 },
  global: CONSOLE_LIMITS.global,
  linkRead: CONSOLE_LIMITS.linkRead,
  breaker: { windowMs: HOUR_MS, perOrg: L.breaker.perOrgPerHour, global: L.breaker.globalPerHour },
} as const satisfies ConsoleAdmission['limits'];

const ipObj = (env: Env, subject: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`platform:ip:${subject}`));
const overflowObj = (env: Env) => placedStub(env, env.RATE_LIMITER, 'platform:ip-overflow');
export const nonceObj = (env: Env, keyId: string) => placedStub(env, env.RATE_LIMITER, `platform-nonce:${keyId}`);
export const keyObj = (env: Env, keyId: string) => placedStub(env, env.RATE_LIMITER, `platform:key:${keyId}`);
const consoleObj = (env: Env) => placedStub(env, env.RATE_LIMITER, CONSOLE_LIMITER);

/** A P-256 point (the generator), verified against when the key id names no key in force: the same work either way. */
const DUMMY_KEY = Uint8Array.from([
  4, 0x6b, 0x17, 0xd1, 0xf2, 0xe1, 0x2c, 0x42, 0x47, 0xf8, 0xbc, 0xe6, 0xe5, 0x63, 0xa4, 0x40, 0xf2, 0x77, 0x03, 0x7d, 0x81, 0x2d, 0xeb, 0x33, 0xa0, 0xf4, 0xa1, 0x39, 0x45,
  0xd8, 0x98, 0xc2, 0x96, 0x4f, 0xe3, 0x42, 0xe2, 0xfe, 0x1a, 0x7f, 0x9b, 0x8e, 0xe7, 0xeb, 0x4a, 0x7c, 0x0f, 0x9e, 0x16, 0x2b, 0xce, 0x33, 0x57, 0x6b, 0x31, 0x5e, 0xce,
  0xcb, 0xb6, 0x40, 0x68, 0x37, 0xbf, 0x51, 0xf5,
]);

/** The one answer to every authentication failure (checks 3's headers and 5). */
export const UNAUTHENTICATED_MESSAGE = 'This request isn’t signed by a platform key in force here. Check the key id, the clock, the signed message and the key.';

/** An IPv4 /24 or IPv6 /48 of the caller, for `platform_calls` and the log (never the full address). */
export function ipPrefix(subject: string): string | null {
  if (subject.startsWith('v4:')) return `${subject.slice(3).split('.').slice(0, 3).join('.')}.0/24`;
  if (subject.startsWith('v6:')) return `${subject.slice(3).split(':').slice(0, 3).join(':')}::/48`;
  return null;
}

/** The key and its org as check 5 reads them. */
export interface AuthRow {
  id: string;
  org_id: string;
  label: string;
  thumbprint: string;
  scopes_json: string;
  active_from: number | null;
  expires_at: number | null;
  public_key: ArrayBuffer;
  in_force: number;
  enabled: number;
  frozen: number;
  max_apps: number | null;
  creations_per_day: number | null;
  proposals_per_day: number | null;
}

interface Outcome {
  status: number;
  code: PlatformErrorCode | RpcCode | null;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Internal only (the request log): why a 401 was answered. */
  why?: string;
}

function answer(o: Outcome, requestId: string): Response {
  return json(o.status, { ...o.body, requestId }, { 'x-request-id': requestId, ...(o.headers ?? {}) });
}

const refusal = (code: PlatformErrorCode, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Outcome => ({
  status: PLATFORM_ERROR_STATUS[code],
  code,
  body: { error, code, ...extra },
  ...(headers ? { headers } : {}),
});
const UNAUTHENTICATED = (why: string): Outcome => ({ ...refusal('unauthenticated', UNAUTHENTICATED_MESSAGE, {}, { 'www-authenticate': 'Journear-Signature' }), why });
const limited = (limit: string, retryAfterS: number, error = 'Too many requests: try again later'): Outcome =>
  refusal('rate_limited', error, { limit, retryAfterS }, { 'retry-after': String(retryAfterS) });
const unavailable = (): Outcome => refusal('rate_limiter_unavailable', 'Our rate limiter is unavailable just now: try again shortly');

async function verifyWith(raw: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as Uint8Array<ArrayBuffer>, message as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/** Reads a body up to `max` bytes (streamed: never buffered beyond it); null when it is longer. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const out = new Uint8Array(max);
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    out.set(value, size);
    size += value.byteLength;
  }
  return out.slice(0, size);
}

/** A security event, written once (its id is deterministic). Never throws. */
async function securityEvent(env: Env, kind: 'platform_quota' | 'platform_auth_failures', idParts: string[], orgId: string, detail: Record<string, unknown>, now: number): Promise<void> {
  try {
    await env.DB.prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await eventId(kind, ...idParts), now, kind, orgId, JSON.stringify(detail))
      .run();
  } catch {
    log({ event: 'platform', outcome: 'error', code: `${kind}_event_failed` }, 'error');
  }
}

/** The first quota refusal of a limit in a clock hour writes `platform_quota` (the caller decides "first"). */
const quotaEvent = (env: Env, orgId: string, keyId: string, limit: string, now: number) => {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  return securityEvent(env, 'platform_quota', [orgId, limit, String(hour)], orgId, { limit, keyId, windowStart: hour }, now);
};

/** A known key id's failed signature, counted on its own object; the 10th in a minute raises `platform_auth_failures` once an hour. */
async function countAuthFailure(env: Env, row: { id: string; org_id: string }, now: number): Promise<void> {
  try {
    const obj = keyObj(env, row.id);
    const r = await obj.hit([...PLATFORM_WINDOWS.authFailures], now);
    if (r.ok) return;
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (!(await obj.reserve(`authfail-noticed@${hour}`, hour + HOUR_MS, now))) return;
    await securityEvent(env, 'platform_auth_failures', [row.id, String(hour)], row.org_id, { keyId: row.id, failures: L.authFailuresAlert, windowMs: MIN, windowStart: hour }, now);
  } catch {
    log({ event: 'platform', outcome: 'error', code: 'auth_failure_count_failed', platformKeyId: row.id }, 'error');
  }
}

/** The route a method and path name, or why not. */
function routeOf(method: string, path: string): { route: PlatformRoute } | { status: 404 | 405; allow?: string } {
  const routes = PLATFORM_ROUTES.filter((r) => r.path === path);
  if (routes.length === 0) return { status: 404 };
  const route = routes.find((r) => r.method === method);
  return route ? { route } : { status: 405, allow: routes.map((r) => r.method).join(', ') };
}

/** Every header's name and value together (Cloudflare's own included). */
function headersSize(h: Headers): number {
  let n = 0;
  for (const [k, v] of h) n += k.length + v.length + 4;
  return n;
}

/** The platform API: checks 1 to 8, then the route, then its record. `now` is injectable for the tests' clocks. */
export async function handlePlatform(request: Request, url: URL, env: Env, requestId: string, ctx: ExecutionContext, now = Date.now()): Promise<Response> {
  const method = request.method;
  const path = url.pathname;
  const subject = ipSubject(request.headers.get('cf-connecting-ip'));
  const prefix = ipPrefix(subject);
  // Known from the path alone, before any check: the one route allowed while the switch is off or a limiter is down.
  const selfRevoke = method === 'POST' && path === `${PLATFORM_PREFIX}/credential/revoke`;
  const fields: { route: string; keyId?: string; orgId?: string } = { route: 'unmatched' };

  const finish = (o: Outcome): Response => {
    const outcome = o.status < 400 ? 'ok' : o.status >= 500 ? 'error' : 'rejected';
    log(
      {
        event: 'platform',
        requestId,
        endpoint: fields.route,
        method,
        outcome,
        status: o.status,
        ...(o.code ? { code: o.code } : {}),
        ...(o.why ? { what: o.why } : {}),
        ...(fields.keyId ? { platformKeyId: fields.keyId } : {}),
        ...(fields.orgId ? { orgId: fields.orgId } : {}),
        ...(prefix ? { ipPrefix: prefix } : {}),
        latencyMs: Date.now() - now,
      },
      o.status >= 500 ? 'error' : o.status === 401 || o.status === 429 ? 'warn' : 'info',
    );
    return answer(o, requestId);
  };

  // 1. The per-IP window of requests not admitted, or the shared overflow window when it is full.
  let slot: { obj: DurableObjectStub<RateLimiter>; limits: Limit[] } | null = null;
  try {
    const ip = ipObj(env, subject);
    const r = await ip.hit([...PLATFORM_WINDOWS.ip], now);
    if (r.ok) slot = { obj: ip, limits: [...PLATFORM_WINDOWS.ip] };
    else {
      const ov = overflowObj(env);
      const o = await ov.hit([...PLATFORM_WINDOWS.overflow], now);
      if (!o.ok) {
        log({ event: 'platform', requestId, code: 'ip_overflow_full', ...(prefix ? { ipPrefix: prefix } : {}) }, 'warn');
        return finish(limited('platform:ip', r.retryAfterS, 'Too many failed requests from this address: try again in a minute'));
      }
      slot = { obj: ov, limits: [...PLATFORM_WINDOWS.overflow] };
    }
  } catch {
    log({ event: 'platform', requestId, outcome: 'error', code: 'ip_limiter_failed' }, 'error');
    if (!selfRevoke) return finish(unavailable());
  }
  const giveBackSlot = async () => {
    if (!slot) return;
    try {
      await slot.obj.unhit(slot.limits, now);
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'ip_unhit_failed' }, 'error');
    }
  };

  // 2. Never for browsers.
  if (request.headers.has('origin')) return finish(refusal('browser_refused', 'The platform API is for your backend only, never a browser'));

  // 3. The shapes, before any signature work.
  if (method !== 'GET' && method !== 'POST') return finish(refusal('method_not_allowed', 'Only GET and POST', {}, { allow: 'GET, POST' }));
  if (!PLATFORM_PATH_RE.test(path)) return finish(refusal('bad_request', 'The path must be /v1/platform/ and plain segments of letters, digits, _ and -, with no empty, dot or encoded segment and no trailing slash'));
  const query = url.search;
  if (query === '' ? url.href.includes('?') : method === 'POST' || !PLATFORM_QUERY_RE.test(query)) return finish(refusal('bad_request', method === 'POST' ? 'A POST takes no query' : 'The query must be one to four name=value pairs of letters, digits, _ and -'));
  const found = routeOf(method, path);
  if (!('route' in found)) {
    return finish(found.status === 404 ? refusal('not_found', 'No such platform route') : refusal('method_not_allowed', `This route takes ${found.allow}`, {}, { allow: found.allow! }));
  }
  const route = found.route;
  fields.route = route.path;
  const h = request.headers;
  if (headersSize(h) > PLATFORM_HEADERS_MAX) return finish(refusal('bad_request', 'The request’s headers are too large'));
  if (h.has('content-encoding')) return finish(refusal('bad_request', 'Send the body without a content-encoding'));
  const declared = h.get('content-length');
  if (method === 'GET') {
    if (h.has('content-type') || h.has('transfer-encoding') || (declared !== null && declared !== '0')) return finish(refusal('bad_request', 'A GET has no body'));
  } else {
    if (!PLATFORM_CONTENT_TYPE_RE.test(h.get('content-type') ?? '')) return finish(refusal('bad_request', 'A POST’s content-type is application/json'));
    if (declared !== null && !(/^[0-9]{1,6}$/u.test(declared) && Number(declared) <= PLATFORM_BODY_MAX)) return finish(refusal('bad_request', `The body is larger than ${PLATFORM_BODY_MAX} bytes`));
  }
  const idem = h.get(PLATFORM_HEADERS.idempotencyKey);
  if (idem !== null && (method === 'GET' || !PLATFORM_HEADER_RES.idempotencyKey.test(idem))) return finish(refusal('bad_request', method === 'GET' ? 'A GET takes no Idempotency-Key' : 'The Idempotency-Key is 8 to 64 letters, digits, _ and -'));
  if (route.idempotency === 'required' && idem === null) return finish(refusal('bad_request', 'This write needs an Idempotency-Key'));
  const keyId = h.get(PLATFORM_HEADERS.keyId);
  const ts = h.get(PLATFORM_HEADERS.timestamp);
  const nonce = h.get(PLATFORM_HEADERS.nonce);
  const sigHeader = h.get(PLATFORM_HEADERS.signature);
  if (keyId !== null && PLATFORM_HEADER_RES.keyId.test(keyId)) fields.keyId = keyId;
  if (keyId === null || ts === null || nonce === null || sigHeader === null || !fields.keyId || !PLATFORM_HEADER_RES.timestamp.test(ts) || !PLATFORM_HEADER_RES.nonce.test(nonce)) {
    return finish(UNAUTHENTICATED('malformed_header'));
  }
  const signature = signatureBytes(sigHeader);
  if (!signature) return finish(UNAUTHENTICATED('malformed_signature'));

  // 4. The clock.
  const timestamp = Number(ts);
  if (Math.abs(now - timestamp) > PLATFORM_CLOCK_SKEW_MS) return finish(refusal('stale_request', 'The request’s timestamp is more than 60 seconds from our clock', { serverTimeMs: now }));

  // 5. The key in force here, and the signature over the exact body.
  const body = method === 'GET' ? await readCapped(request, 0) : await readCapped(request, PLATFORM_BODY_MAX);
  if (body === null) return finish(refusal('bad_request', method === 'GET' ? 'A GET has no body' : `The body is larger than ${PLATFORM_BODY_MAX} bytes`));
  const db = new HotDb(env.DB, PLATFORM_DB_LIMITS);
  let row: AuthRow | null;
  try {
    row = await db.first<AuthRow>(
      q`SELECT k.id, k.org_id, k.label, k.thumbprint, k.scopes_json, k.active_from, k.expires_at, k.public_key, ${KEY_IN_FORCE('k', now)} AS in_force,
               COALESCE(po.enabled, 0) AS enabled, COALESCE(po.frozen, 0) AS frozen, po.max_apps, po.creations_per_day, po.proposals_per_day
          FROM platform_keys k LEFT JOIN platform_orgs po ON po.org_id = k.org_id WHERE k.id = ${keyId}`,
    );
  } catch {
    return finish(refusal('internal', 'Internal error'));
  }
  const message = utf8(
    platformRequestMessage({
      envName: env.ENV_NAME,
      signerAccount: env.SIGNER_ACCOUNT,
      method,
      path: `${path}${query}`,
      keyId,
      timestamp: ts,
      nonce,
      idempotencyKey: idem ?? undefined,
      bodySha256Hex: await bodySha256Hex(body),
    }),
  );
  const raw = row && row.in_force === 1 ? new Uint8Array(row.public_key) : null;
  const verified = await verifyWith(raw && raw.length === 65 ? raw : DUMMY_KEY, signature, message);
  if (!verified || !raw || !row) {
    // Counted for a known key id after the answer (waitUntil), so a known and an unknown id take the same time.
    if (row) ctx.waitUntil(countAuthFailure(env, row, now));
    return finish(UNAUTHENTICATED(!row ? 'unknown_key' : !raw ? 'not_in_force' : 'bad_signature'));
  }
  const key = row;
  fields.orgId = key.org_id;

  // 6. The org's switch and the freeze mirror (the self-revoke works either way).
  if (key.enabled !== 1 && !route.allowOff) return finish(refusal('platform_off', 'Journear’s platform API is switched off for your organisation. Your key can still stop itself: POST /v1/platform/credential/revoke'));
  if (key.frozen === 1 && !route.allowFrozen) return finish(refusal('forbidden', 'Journear has paused your organisation: only stopping things works for now'));

  // 7. The nonce, once.
  try {
    const n = await nonceObj(env, keyId).reserveNonce(nonce, timestamp + PLATFORM_NONCE_HOLD_MS, [...PLATFORM_WINDOWS.nonce], now);
    if (n === 'replayed') return finish(refusal('request_replayed', 'This request was already received: sign each request with a fresh nonce'));
    if (n === 'full') return finish(limited('platform:nonce', 60, 'Too many requests for this key just now: try again in a minute'));
  } catch {
    log({ event: 'platform', requestId, outcome: 'error', code: 'nonce_limiter_failed', platformKeyId: keyId }, 'error');
    if (!selfRevoke) return finish(unavailable());
  }

  // 8. The key's windows and the org's bucket (and breaker); the self-revoke skips them.
  let lastUsed = false;
  let settle: { breaker: boolean; reserveUsed: number } | null = null;
  if (route.admission === 'limits') {
    const kobj = keyObj(env, keyId);
    try {
      const k = await kobj.hitMark([...PLATFORM_WINDOWS.key], `last-used@${Math.floor(now / HOUR_MS)}`, now + HOUR_MS, now);
      if (!k.ok) {
        ctx.waitUntil(
          kobj
            .reserve(`quota-noticed:${k.limit}@${Math.floor(now / HOUR_MS)}`, now + HOUR_MS, now)
            .then((first) => (first ? quotaEvent(env, key.org_id, keyId, k.limit, now) : undefined))
            .catch(() => undefined),
        );
        return finish(limited(`platform:key:${k.limit}`, k.retryAfterS));
      }
      lastUsed = k.marked === true;
      const b = await consoleObj(env).consoleAdmit({ ns: 'platform', org: key.org_id, cost: route.cost, ...(route.killSwitch ? { killSwitch: true } : {}), ...(route.breaker ? { breaker: true } : {}), limits: PLATFORM_LIMITS }, now);
      if (!b.ok) {
        await kobj.unhit([...PLATFORM_WINDOWS.key], now);
        if (lastUsed) await kobj.release(`last-used@${Math.floor(now / HOUR_MS)}`);
        if (b.notify) ctx.waitUntil(quotaEvent(env, key.org_id, keyId, `platform:${b.limit}`, now));
        const breaker = b.limit === 'breaker_org' || b.limit === 'breaker_global';
        return finish(limited(`platform:${b.limit}`, b.retryAfterS, breaker ? 'Too many destructive changes this hour: ask Journear security' : 'Too many platform requests for your organisation just now: try again shortly'));
      }
      settle = { breaker: !!route.breaker, reserveUsed: b.reserveUsed };
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'key_limiter_failed', platformKeyId: keyId }, 'error');
      return finish(unavailable());
    }
  }

  // Admitted: the IP's slot back (only requests not admitted use it).
  await giveBackSlot();

  // The body, then the route, then the call's record.
  let parsed: unknown = undefined;
  let out: Outcome;
  let appId: string | null = null;
  let wrote = false;
  if (method === 'POST') {
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      parsed = Symbol.for('invalid');
    }
  }
  if (method === 'POST' && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
    out = refusal('bad_request', 'The body must be a JSON object (send {} when there is nothing to say)');
  } else {
    try {
      const r: RouteAnswer = await route.run({ env, db, key, body: parsed, now, idempotencyKey: idem, requestId });
      out = { status: r.status, code: null, body: r.body };
      appId = r.appId ?? null;
      wrote = r.wrote === true;
    } catch (err) {
      if (err instanceof RpcRefusal) out = { status: RPC_HTTP_STATUS[err.code], code: err.code, body: { error: err.message.slice(0, 500), code: err.code } };
      else {
        log({ event: 'platform', requestId, outcome: 'error', code: 'route_failed', platformKeyId: keyId, endpoint: route.path }, 'error');
        out = refusal('internal', 'Internal error');
      }
    }
  }
  // A destructive call that changed nothing gets its breaker slot back, and its reserve tokens move to the org's bucket.
  if (settle && (settle.breaker || settle.reserveUsed > 0) && !wrote) {
    try {
      await consoleObj(env).consoleSettle({ ns: 'platform', org: key.org_id, at: now, breaker: settle.breaker, reserveUsed: settle.reserveUsed, limits: PLATFORM_LIMITS }, now);
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'settle_failed' }, 'error');
    }
  }
  try {
    await db.batch([
      q`INSERT INTO platform_calls (at, org_id, key_id, method, route, app_id, status, code, request_id, ip_prefix)
        VALUES (${now}, ${key.org_id}, ${keyId}, ${method}, ${route.path}, ${appId}, ${out.status}, ${out.code}, ${requestId}, ${prefix})`,
      ...(lastUsed ? [q`UPDATE platform_keys SET last_used_at = ${now} WHERE id = ${keyId} AND (last_used_at IS NULL OR last_used_at < ${now})`] : []),
    ]);
  } catch {
    log({ event: 'platform', requestId, outcome: 'error', code: 'call_log_failed', platformKeyId: keyId, endpoint: route.path }, 'error');
    // A read is never answered unrecorded; a write that committed is answered (its ledger row records it).
    if (!wrote) out = refusal('internal', 'Internal error');
  }
  return finish(out);
}
