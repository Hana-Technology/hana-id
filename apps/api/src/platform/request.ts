// The platform API's request authentication and admission (D927; docs/partner-platform-spec.md A3 "The request", A5,
// A7 `platform_calls`, L7; findings M2, M3, M4, L1, L2, L5, L8). Every `/v1/platform…` request goes through these
// checks in this order, failing closed:
//
//   1. Per IP, requests not admitted: a `hit` on `platform:ip:<subject>` (30 a minute, not pinned; IPv4 by address,
//      IPv6 by /48), given back once the request is admitted (after 8), so only failures and refusals use it. When that
//      window is full: a key id not on the isolate's list of announced keys (known-keys.ts) gets the one 401 at once,
//      with no body read, no D1 read and no verification (N4); a listed id goes on under its own overflow window for this IP subject
//      (`platform:keyfail:<keyId>:<subject>`, pinned, 20 a minute, N1); past that, a self-revoke's signature is checked
//      against the listed point (CPU only), a valid one going on and a failed one counted (60 a minute per key and
//      subject, the CPU bound); anything else is 429 (M2; F2; after the second review, N1).
//   2. An `Origin` header: 403 browser_refused, with no CORS header (never for browsers).
//   3. The shapes, each matched in full, before any signature work: GET or POST (405); the one parsed path and query
//      (400); a known route and its method (404, 405); every header together at most 16 KiB; a GET with no body, no
//      content type and no encoding, a POST with `application/json`, no `content-encoding` and at most 16 KiB (400);
//      `Idempotency-Key`'s form (400); the four `Journear-*` headers (401 unauthenticated).
//   4. The timestamp within ±60 s of the API's clock: else 400 stale_request with `serverTimeMs` only.
//   5. The key id on the isolate's list of announced keys (else the one 401 with no D1 read, after a verification against
//      the dummy key so the CPU work matches), then one D1 read: the key in force here (KEY_IN_FORCE) with its org's
//      switch row; the body read (16 KiB at most) and hashed; the signature verified with WebCrypto's plain ES256 over
//      the canonical message (console-core `platformRequestMessage`). A key not in force, or whose stored point doesn't
//      import, is verified against a fixed dummy key whose private key nobody knows (F7), and answers the same 401.
//   6. The org's platform switch on (403 platform_off) and the org not frozen (403 forbidden), as the API's mirror
//      `platform_orgs` says (the freeze mirror lags a console freeze by up to about an hour when its write fails:
//      D918). The self-revoke is allowed either way (L5).
//   7. For the self-revoke, its body parsed and checked first (F1). A valid self-revoke reserves its nonce with no cap
//      (it can succeed once per key, so a thief filling the cap can't hold it back) and skips 8. Anything else reserves
//      the nonce until timestamp + 120 s on `platform-nonce:<keyId>` (pinned), at most 300 fresh nonces a minute per key:
//      a second use is 409 request_replayed, past the cap 429.
//   8. A valid self-revoke: only its own window (10 a minute on the key's object, N3). Anything else: the key's own
//      windows (`platform:key:<keyId>`, pinned: 60 a minute, 2 000 a UTC day; a kill switch past them, its own reserve
//      of 10 a minute and 100 a UTC day, D935) and the platform's
//      admission on the `console-rpc` object (rate-limiter.ts `platformAdmit`): an ordinary call, the org's bucket and
//      the platform's global bucket, never any of the console's (D938); a kill switch, its org's kill bucket only
//      (D935); and the platform's own destructive-call breaker on web address
//      removals, each org's first 5 an hour past the global count (M3, F3, D935). An invalid self-revoke goes through 8
//      like any other call.
//
// The body must all arrive within 5 s (else 400), and the request's clock is read again once it has: the timestamp
// window holds then too, and every limiter and record uses that time (D935, H1). The limiters reckon on their own
// clocks anyway.
//
// Only then is the body parsed and the route run, within PLATFORM_DB_LIMITS, and the call written to `platform_calls`
// (with, at most once an hour per key, `last_used_at`). A limiter that errors is 503 rate_limiter_unavailable; for the
// valid self-revoke it is logged at error level and the stop goes ahead (a replayed stop can only stop the same key).
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
  MAX_PLATFORM_ORGS,
  type PlatformErrorCode,
  PLATFORM_ERROR_STATUS,
  RPC_HTTP_STATUS,
  type RpcCode,
  bodySha256Hex,
  fromHex,
  platformRequestMessage,
  signatureBytes,
  utf8,
} from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { json } from '../http.ts';
import { ipSubject } from '../ip.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { Limit, PlatformAdmission, RateLimiter } from '../rate-limiter.ts';
import { RpcRefusal } from '../changes/cas.ts';
import { HotDb, PLATFORM_DB_LIMITS } from '../changes/db.ts';
import { CONSOLE_LIMITER, HOUR_MS } from '../changes/guard.ts';
import { q } from '../changes/sql.ts';
import { platformQuotaEvent, platformSecurityEvent } from './events.ts';
import { KEY_IN_FORCE } from './keys.ts';
import { type KnownKey, type KnownKeys, alertedThisMinute, knownKeyIds, noteAlerted } from './known-keys.ts';
import { PlatformRefusal } from './refusal.ts';
import { type RouteAnswer, matchRoute } from './routes.ts';

export const PLATFORM_PREFIX = '/v1/platform';
/** Whether the router hands a path to the platform API (anything under the prefix, so a malformed one is its 400). */
export const isPlatformPath = (pathname: string): boolean => pathname.startsWith(PLATFORM_PREFIX);

const MIN = 60_000;
const DAY = 24 * HOUR_MS;
const L = PLATFORM_REQUEST_LIMITS;
export const PLATFORM_WINDOWS = {
  /** Requests not admitted, per IP (check 1). */
  ip: [{ name: 'fail:minute', windowMs: MIN, max: L.failuresPerIpPerMinute }],
  /** Requests naming this key checked while their IP's window was full (check 1, M2, F2), on the key's failure object. */
  overflow: [{ name: 'overflow:minute', windowMs: MIN, max: L.overflowPerKeyPerMinute }],
  /**
   * Self-revokes naming this key, from this IP subject, whose signature failed the check against the listed point past
   * full windows (check 1, N1): the bound on that CPU work; a valid signature gives its slot back.
   */
  revokePreauth: [{ name: 'revoke-preauth:minute', windowMs: MIN, max: L.revokePreauthFailuresPerKeyPerMinute }],
  /** Valid self-revokes of a key (N3): the bound while a revocation can't land. */
  validRevokes: [{ name: 'revoke:minute', windowMs: MIN, max: L.validRevokesPerKeyPerMinute }],
  /** Fresh nonces per key (check 7: the nonce object's size bound; a valid self-revoke is outside it). */
  nonce: [{ name: 'nonce:minute', windowMs: MIN, max: L.noncesPerKeyPerMinute }],
  /** Requests admitted per key (check 8). */
  key: [
    { name: 'req:minute', windowMs: MIN, max: L.perKeyPerMinute },
    { name: 'req:day', windowMs: DAY, max: L.perKeyPerDay },
  ],
  /**
   * D935: a kill switch's own reserve per key, counted apart and only once the ordinary windows above are full, so a key
   * that used its 60 a minute or 2 000 a day can still stop things (10 a minute, 100 a UTC day).
   */
  killReserve: [
    { name: 'kill:minute', windowMs: MIN, max: L.killReservePerKeyPerMinute },
    { name: 'kill:day', windowMs: DAY, max: L.killReservePerKeyPerDay },
  ],
  /** Failed signatures for a known key id: the 10th in a minute raises `platform_auth_failures`. */
  authFailures: [{ name: 'authfail:minute', windowMs: MIN, max: L.authFailuresAlert - 1 }],
} as const satisfies Record<string, Limit[]>;

/**
 * The platform's admission on the `console-rpc` object (A5; F3; D935 after PR 161's second full review; D938): two
 * budget classes that never charge each other, on buckets of the platform's own (no platform call touches any of the
 * console's, nor a console call any of these). An ordinary call: the org's own bucket (8 statements a second, burst 40:
 * 520 a minute) and the platform's global bucket (10 a second, burst 60: 660 in a first minute, 600 after), which alone
 * bounds every org's ordinary calls together, whatever the number of organisations; no reserve. A
 * kill switch: its org's kill bucket only (2.5 statements a second, burst 44: about 13 a minute, 4 at once), so no other
 * org can slow it and it slows nobody's ordinary calls; at most MAX_PLATFORM_ORGS orgs' kill buckets a minute (the
 * backstop to the cap on orgs switched on). Removals also take a breaker slot (10 per org, 30 across orgs a rolling
 * hour, each org's first 5 past the global count). No tokens are given back. To confirm (the Tech Lead): the numbers.
 */
export const PLATFORM_LIMITS = {
  perOrg: { ratePerS: 8, burst: 40 },
  platform: { ratePerS: 10, burst: 60 },
  breaker: { windowMs: HOUR_MS, perOrg: L.breaker.perOrgPerHour, global: L.breaker.globalPerHour, floor: L.breaker.floorPerOrgPerHour },
  kill: { ratePerS: L.killBucket.ratePerS, burst: L.killBucket.burst },
  maxOrgs: MAX_PLATFORM_ORGS,
} as const satisfies PlatformAdmission['limits'];

/** What a call refused before its route (a bad body after admission) is charged: the key's read and the call's row. */
export const REFUSED_CALL_COST = 3;

/**
 * The per-IP window's subject: IPv4 by address, IPv6 by /48 (F5: a /64 per subject let one /48 holder spread 65 536
 * windows; a valid key behind a /48 others fail from still gets in through its own overflow window, F2).
 */
export function platformIpSubject(raw: string | null): string {
  const s = ipSubject(raw);
  if (!s.startsWith('v6:')) return s;
  return `v6:${s.slice(3).split(':').slice(0, 3).join(':')}::/48`;
}

const ipObj = (env: Env, subject: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`platform:ip:${subject}`));
export const nonceObj = (env: Env, keyId: string) => placedStub(env, env.RATE_LIMITER, `platform-nonce:${keyId}`);
export const keyObj = (env: Env, keyId: string) => placedStub(env, env.RATE_LIMITER, `platform:key:${keyId}`);
/**
 * A key's failure objects (F5): per IP subject, its overflow and pre-auth windows (N1); without one, its failure count;
 * all apart from the object its admitted traffic uses.
 */
export const keyFailObj = (env: Env, keyId: string, subject?: string) => placedStub(env, env.RATE_LIMITER, subject === undefined ? `platform:keyfail:${keyId}` : `platform:keyfail:${keyId}:${subject}`);
const consoleObj = (env: Env) => placedStub(env, env.RATE_LIMITER, CONSOLE_LIMITER);

/**
 * The point verified against when a key id names no key in force (F7): x = sha256("journear-platform-v1 dummy
 * verification key 4") mod p, the first counter whose x is on P-256, with the even y. Hashed to the curve, not a
 * multiple of the generator, so nobody knows its private key (the test recomputes it).
 */
export const DUMMY_KEY = fromHex('0455ebef339471ccf4d0bec9da26b414896c4aa19b1dda923b149b8977f57f22ab8107b9cf741300663b447a45c569e41d27d454166f001d863f2cd6e58c69ae3e');

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

/** A stored point as a WebCrypto key, or null when it isn't exactly 65 bytes of a P-256 point (F7). */
async function importPoint(raw: Uint8Array): Promise<CryptoKey | null> {
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return null;
  }
}

async function verifyWith(key: CryptoKey, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as Uint8Array<ArrayBuffer>, message as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/**
 * Reads a body up to `max` bytes (streamed: never buffered beyond it); null when it is longer, `'slow'` when it hasn't
 * all arrived `deadlineMs` after the read began (D935, H1: a slow upload can't hold a request open past its clock).
 */
async function readCapped(request: Request, max: number, deadlineMs = L.bodyDeadlineMs): Promise<Uint8Array | null | 'slow'> {
  if (!request.body) return new Uint8Array(0);
  const out = new Uint8Array(max);
  let size = 0;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), deadlineMs);
  });
  // The timer is cleared however the read ends: done, too long, too slow, or the stream failing (after PR 161's third review).
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), late]);
      if (next === 'slow') {
        await reader.cancel().catch(() => undefined);
        return 'slow';
      }
      const { done, value } = next;
      if (done) break;
      if (size + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      out.set(value, size);
      size += value.byteLength;
    }
  } finally {
    clearTimeout(timer);
  }
  return out.slice(0, size);
}

const quotaEvent = platformQuotaEvent;
const securityEvent = platformSecurityEvent;

/**
 * A known key id's failed signature, counted on its failure object; the 10th in a minute raises
 * `platform_auth_failures` once an hour. Once the minute's alert has fired, this isolate stops calling the object for
 * the rest of the minute (F5).
 */
async function countAuthFailure(env: Env, row: { id: string; org_id: string }, now: number): Promise<void> {
  const minute = Math.floor(now / MIN);
  if (alertedThisMinute(row.id, minute)) return;
  try {
    const obj = keyFailObj(env, row.id);
    const r = await obj.hit([...PLATFORM_WINDOWS.authFailures], now);
    if (r.ok) return;
    noteAlerted(row.id, minute);
    const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
    if (!(await obj.reserve(`authfail-noticed@${hour}`, hour + HOUR_MS, now))) return;
    await securityEvent(env, 'platform_auth_failures', [row.id, String(hour)], row.org_id, { keyId: row.id, failures: L.authFailuresAlert, windowMs: MIN, windowStart: hour }, now);
  } catch {
    log({ event: 'platform', outcome: 'error', code: 'auth_failure_count_failed', platformKeyId: row.id }, 'error');
  }
}

/** Every header's name and value together (Cloudflare's own included). */
function headersSize(h: Headers): number {
  let n = 0;
  for (const [k, v] of h) n += k.length + v.length + 4;
  return n;
}

/** A POST's body as JSON, or `undefined` when it isn't a JSON object (any other JSON, or not UTF-8 JSON at all). */
function jsonObject(body: Uint8Array): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const NOT_AN_OBJECT = 'The body must be a JSON object (send {} when there is nothing to say)';

/** The platform API: checks 1 to 8, then the route, then its record. `now` is injectable for the tests' clocks. */
export async function handlePlatform(request: Request, url: URL, env: Env, requestId: string, ctx: ExecutionContext, injectedNow?: number): Promise<Response> {
  const method = request.method;
  const path = url.pathname;
  const h = request.headers;
  const subject = platformIpSubject(h.get('cf-connecting-ip'));
  const prefix = ipPrefix(ipSubject(h.get('cf-connecting-ip')));
  // Known from the path alone, before any check: the one route allowed while the switch is off or a limiter is down.
  const revokePath = method === 'POST' && path === `${PLATFORM_PREFIX}/credential/revoke`;
  const sentKeyId = h.get(PLATFORM_HEADERS.keyId);
  const idWellFormed = sentKeyId !== null && PLATFORM_HEADER_RES.keyId.test(sentKeyId);
  const fields: { route: string; keyId?: string; orgId?: string } = { route: 'unmatched', ...(idWellFormed ? { keyId: sentKeyId } : {}) };

  // D935 (H1): the request's clock. `now` is its time at the start, then read again once the body has arrived, so every
  // limiter, the timestamp window and the records use a time taken after the upload. A test injects a fixed time.
  const realStart = performance.now();
  const clock = () => injectedNow ?? Date.now();
  let now = clock();
  let hourMark = Math.floor(now / HOUR_MS);
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
        latencyMs: Math.round(performance.now() - realStart),
      },
      o.status >= 500 ? 'error' : o.status === 401 || o.status === 429 ? 'warn' : 'info',
    );
    return answer(o, requestId);
  };

  // The isolate's list of announced keys (F2, F5, N1): asked at most once a request.
  let known: KnownKeys | null = null;
  const listed = async (): Promise<KnownKey | undefined> => {
    if (!idWellFormed) return undefined;
    known ??= await knownKeyIds(env);
    return known.get(sentKeyId);
  };
  const isKnown = async (): Promise<boolean> => (await listed()) !== undefined;

  // 1. The per-IP window of requests not admitted. Past it: an id not on the list (or no well-formed id) gets the one 401
  // at once, with no body read, no D1 read and no verification (N4 and its review: the same bytes as any authentication
  // failure, the work bounded); a listed id under its own overflow window for
  // this IP subject (N1: one address can't spend another's); past that too, a self-revoke is still checked, its
  // signature against the listed point before any refusal (`preauth`, N1); anything else is 429.
  let slot: { obj: DurableObjectStub<RateLimiter>; limits: Limit[]; at: number } | null = null;
  let preauth: { obj: DurableObjectStub<RateLimiter>; retryAfterS: number } | null = null;
  try {
    const ip = ipObj(env, subject);
    const r = await ip.hit([...PLATFORM_WINDOWS.ip], now);
    if (r.ok) slot = { obj: ip, limits: [...PLATFORM_WINDOWS.ip], at: now };
    else if (await isKnown()) {
      const kf = keyFailObj(env, sentKeyId!, subject);
      const o = await kf.hit([...PLATFORM_WINDOWS.overflow], now);
      if (o.ok) slot = { obj: kf, limits: [...PLATFORM_WINDOWS.overflow], at: now };
      else if (revokePath) preauth = { obj: kf, retryAfterS: r.retryAfterS };
      else {
        log({ event: 'platform', requestId, code: 'key_overflow_full', platformKeyId: sentKeyId!, ...(prefix ? { ipPrefix: prefix } : {}) }, 'warn');
        return finish(limited('platform:ip', r.retryAfterS, 'Too many failed requests from this address: try again in a minute'));
      }
    } else return finish(UNAUTHENTICATED('unlisted_past_full_window'));
  } catch {
    log({ event: 'platform', requestId, outcome: 'error', code: 'ip_limiter_failed' }, 'error');
    if (!revokePath) return finish(unavailable());
  }
  const giveBackSlot = async () => {
    if (!slot) return;
    try {
      await slot.obj.unhit(slot.limits, slot.at);
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'ip_unhit_failed' }, 'error');
    }
  };

  // 2. Never for browsers.
  if (h.has('origin')) return finish(refusal('browser_refused', 'The platform API is for your backend only, never a browser'));

  // 3. The shapes, before any signature work.
  if (method !== 'GET' && method !== 'POST') return finish(refusal('method_not_allowed', 'Only GET and POST', {}, { allow: 'GET, POST' }));
  if (!PLATFORM_PATH_RE.test(path)) return finish(refusal('bad_request', 'The path must be /v1/platform/ and plain segments of letters, digits, _ and -, with no empty, dot or encoded segment and no trailing slash'));
  const query = url.search;
  if (query === '' ? url.href.includes('?') : method === 'POST' || !PLATFORM_QUERY_RE.test(query)) return finish(refusal('bad_request', method === 'POST' ? 'A POST takes no query' : 'The query must be one to four name=value pairs of letters, digits, _ and -'));
  const found = matchRoute(method, path);
  if (!('route' in found)) {
    return finish(found.status === 404 ? refusal('not_found', 'No such platform route') : refusal('method_not_allowed', `This route takes ${found.allow}`, {}, { allow: found.allow! }));
  }
  const route = found.route;
  const params = found.params;
  fields.route = route.path;
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
  const ts = h.get(PLATFORM_HEADERS.timestamp);
  const nonce = h.get(PLATFORM_HEADERS.nonce);
  const sigHeader = h.get(PLATFORM_HEADERS.signature);
  if (!idWellFormed || ts === null || nonce === null || sigHeader === null || !PLATFORM_HEADER_RES.timestamp.test(ts) || !PLATFORM_HEADER_RES.nonce.test(nonce)) {
    return finish(UNAUTHENTICATED('malformed_header'));
  }
  const keyId = sentKeyId!;
  const signature = signatureBytes(sigHeader);
  if (!signature) return finish(UNAUTHENTICATED('malformed_signature'));

  // 4. The clock.
  const timestamp = Number(ts);
  if (Math.abs(now - timestamp) > PLATFORM_CLOCK_SKEW_MS) return finish(refusal('stale_request', 'The request’s timestamp is more than 60 seconds from our clock', { serverTimeMs: now }));

  // 5. The key: on the announced list (else no D1 read), in force here, its point importing, the signature verifying.
  const read = method === 'GET' ? await readCapped(request, 0) : await readCapped(request, PLATFORM_BODY_MAX);
  if (read === 'slow') return finish(refusal('bad_request', `The body took longer than ${L.bodyDeadlineMs / 1000} seconds to arrive: send it at once`));
  if (read === null) return finish(refusal('bad_request', method === 'GET' ? 'A GET has no body' : `The body is larger than ${PLATFORM_BODY_MAX} bytes`));
  const body = read;
  // The clock again, now the body is in (H1): the timestamp window holds at this time too, and every later check uses it.
  now = clock();
  hourMark = Math.floor(now / HOUR_MS);
  if (Math.abs(now - timestamp) > PLATFORM_CLOCK_SKEW_MS) return finish(refusal('stale_request', 'The request’s timestamp is more than 60 seconds from our clock', { serverTimeMs: now }));
  const bodyHash = await bodySha256Hex(body);
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
      bodySha256Hex: bodyHash,
    }),
  );
  // A self-revoke past full windows (N1): its signature against the listed point, CPU only, no D1 read. A valid one
  // goes on to the real check 5; a failed one is counted on this key and IP subject's failed-verification window, and a
  // full window refuses further ones without verifying (the CPU bound). Never charged for a valid signature.
  if (preauth) {
    try {
      const entry = await listed();
      const inForce = entry !== undefined && entry.activeFrom !== null && entry.activeFrom <= now && (entry.expiresAt === null || entry.expiresAt > now);
      const point = inForce ? await importPoint(entry.point) : null;
      const room = await preauth.obj.hit([...PLATFORM_WINDOWS.revokePreauth], now);
      if (!room.ok) {
        log({ event: 'platform', requestId, code: 'revoke_preauth_full', platformKeyId: keyId, ...(prefix ? { ipPrefix: prefix } : {}) }, 'warn');
        return finish(limited('platform:ip', preauth.retryAfterS, 'Too many failed requests from this address: try again in a minute'));
      }
      if (point && (await verifyWith(point, signature, message))) await preauth.obj.unhit([...PLATFORM_WINDOWS.revokePreauth], now);
      else return finish(limited('platform:ip', preauth.retryAfterS, 'Too many failed requests from this address: try again in a minute'));
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'ip_limiter_failed' }, 'error');
    }
  }
  const db = new HotDb(env.DB, PLATFORM_DB_LIMITS);
  let row: AuthRow | null = null;
  try {
    if (await isKnown()) {
      row = await db.first<AuthRow>(
        q`SELECT k.id, k.org_id, k.label, k.thumbprint, k.scopes_json, k.active_from, k.expires_at, k.public_key, ${KEY_IN_FORCE('k', now)} AS in_force,
                 COALESCE(po.enabled, 0) AS enabled, COALESCE(po.frozen, 0) AS frozen, po.max_apps, po.creations_per_day, po.proposals_per_day
            FROM platform_keys k LEFT JOIN platform_orgs po ON po.org_id = k.org_id WHERE k.id = ${keyId}`,
      );
    }
  } catch {
    return finish(refusal('internal', 'Internal error'));
  }
  // Only a key in force whose stored point imports is ever verified against (F7); anything else, the dummy point.
  const real = row && row.in_force === 1 && row.public_key ? await importPoint(new Uint8Array(row.public_key)) : null;
  const verified = await verifyWith(real ?? (await importPoint(DUMMY_KEY))!, signature, message);
  if (!verified || !real || !row) {
    // Counted for a known key id after the answer (waitUntil), so a known and an unknown id take the same time here.
    if (row) ctx.waitUntil(countAuthFailure(env, row, now));
    return finish(UNAUTHENTICATED(!row ? 'unknown_key' : !real ? 'not_in_force' : 'bad_signature'));
  }
  const key = row;
  fields.orgId = key.org_id;

  // The body: parsed now (the suspend route's flags depend on it, D929); a self-revoke's checked now (F1), any other's
  // answered once admitted. A body that isn't valid gets only the route's static flags.
  const parsed = method === 'POST' ? jsonObject(body) : undefined;
  const problem = method === 'POST' && parsed === undefined ? NOT_AN_OBJECT : parsed !== undefined && route.validate ? route.validate(parsed) : null;
  const flags = { killSwitch: route.killSwitch === true, breaker: route.breaker === true, allowFrozen: route.allowFrozen === true, ...(problem === null && parsed !== undefined && route.flags ? route.flags(parsed) : {}) };

  // 6. The org's switch and the freeze mirror (the self-revoke works either way; a frozen org keeps its kill switches).
  if (key.enabled !== 1 && !route.allowOff) return finish(refusal('platform_off', 'Journear’s platform API is switched off for your organisation. Your key can still stop itself: POST /v1/platform/credential/revoke'));
  if (key.frozen === 1 && !flags.allowFrozen) return finish(refusal('forbidden', 'Journear has paused your organisation: only stopping things works for now'));
  const validRevoke = route.selfRevoke === true && problem === null;

  // 7. The nonce, once (a valid self-revoke outside the cap: it can succeed once per key).
  try {
    const n = await nonceObj(env, keyId).reserveNonce(nonce, timestamp + PLATFORM_NONCE_HOLD_MS, validRevoke ? [] : [...PLATFORM_WINDOWS.nonce], now, timestamp + PLATFORM_CLOCK_SKEW_MS);
    if (n === 'stale') return finish(refusal('stale_request', 'The request’s timestamp is more than 60 seconds from our clock', { serverTimeMs: Date.now() }));
    if (n === 'replayed') return finish(refusal('request_replayed', 'This request was already received: sign each request with a fresh nonce'));
    if (n === 'full') return finish(limited('platform:nonce', 60, 'Too many requests for this key just now: try again in a minute'));
  } catch {
    log({ event: 'platform', requestId, outcome: 'error', code: 'nonce_limiter_failed', platformKeyId: keyId }, 'error');
    if (!validRevoke) return finish(unavailable());
  }

  // 8. The key's windows and the platform's admission; a valid self-revoke skips them (charged afterwards if it failed).
  const kobj = keyObj(env, keyId);
  let charged = false;
  // D935: the windows the call was counted on (a kill switch past the ordinary ones: its reserve's).
  let chargedWindows: Limit[] = [...PLATFORM_WINDOWS.key];
  let chargedAt = now;
  let lastUsed = false;
  let settle: { breaker: boolean; at: number } | null = null;
  const undoCharge = async () => {
    if (!charged) return;
    try {
      await kobj.unhit(chargedWindows, chargedAt);
      if (lastUsed) await kobj.release(`last-used@${hourMark}`);
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'key_unhit_failed', platformKeyId: keyId }, 'error');
    }
    charged = false;
    lastUsed = false;
  };
  if (validRevoke) {
    // N3: valid self-revokes of a key are counted too (10 a minute on its key object), so while a revocation can't land
    // (a D1 error) they can't write rows and nonce markers without bound; only valid ones fill it, and one landing stops
    // the key. A limiter error lets the stop go ahead.
    try {
      const v = await kobj.hit([...PLATFORM_WINDOWS.validRevokes], now);
      if (!v.ok) return finish(limited(`platform:key:${v.limit}`, v.retryAfterS, 'This key’s stop was sent many times just now: check the key in the partner portal'));
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'key_limiter_failed', platformKeyId: keyId }, 'error');
    }
  } else {
    const cost = problem === null ? route.cost : REFUSED_CALL_COST;
    const killSwitch = problem === null && flags.killSwitch;
    const breaker = problem === null && flags.breaker;
    let stage = 'key';
    try {
      // D935: a kill switch the ordinary windows refuse is counted on its own reserve instead (atomic in the key's object).
      const k = await kobj.hitMark([...PLATFORM_WINDOWS.key], `last-used@${hourMark}`, now + HOUR_MS, now, killSwitch ? [...PLATFORM_WINDOWS.killReserve] : []);
      if (!k.ok) {
        ctx.waitUntil(
          kobj
            .reserve(`quota-noticed:${k.limit}@${hourMark}`, now + HOUR_MS, now)
            .then((first) => (first ? quotaEvent(env, key.org_id, keyId, k.limit, now) : undefined))
            .catch(() => undefined),
        );
        return finish(limited(`platform:key:${k.limit}`, k.retryAfterS));
      }
      charged = true;
      chargedAt = now;
      if (k.reserve) chargedWindows = [...PLATFORM_WINDOWS.killReserve];
      lastUsed = k.marked === true;
      stage = 'admit';
      const b = await consoleObj(env).platformAdmit({ org: key.org_id, cost, ...(killSwitch ? { killSwitch: true } : {}), ...(breaker ? { breaker: true } : {}), limits: PLATFORM_LIMITS }, now);
      if (!b.ok) {
        await undoCharge();
        if (b.notify) ctx.waitUntil(quotaEvent(env, key.org_id, keyId, `platform:${b.limit}`, now));
        const breakerRefusal = b.limit === 'breaker_org' || b.limit === 'breaker_global';
        if (b.limit === 'kill_orgs') log({ event: 'platform', requestId, outcome: 'error', code: 'kill_orgs_full', platformKeyId: keyId, orgId: key.org_id }, 'error');
        const words = breakerRefusal
          ? 'Too many destructive changes this hour: ask Journear security'
          : b.limit === 'budget_kill'
            ? 'Too many off switches from your organisation just now (about 13 a minute): try again shortly'
            : b.limit === 'kill_orgs'
              ? 'Journear can’t take off switches from your organisation through the API just now: stop things in the partner portal, or ask Journear'
              : 'Too many platform requests just now: try again shortly';
        return finish(limited(`platform:${b.limit}`, b.retryAfterS, words));
      }
      settle = { breaker, at: b.at };
    } catch {
      // F11: a failure after the key's windows counted gives the charge and the last-used marker back.
      await undoCharge();
      log({ event: 'platform', requestId, outcome: 'error', code: stage === 'key' ? 'key_limiter_failed' : 'admission_failed', platformKeyId: keyId }, 'error');
      return finish(unavailable());
    }
  }

  // Admitted: the IP's slot back (only requests not admitted use it).
  await giveBackSlot();

  // The route, then the call's record.
  let out: Outcome;
  let appId: string | null = null;
  let wrote = false;
  if (problem !== null) out = refusal('bad_request', problem);
  else {
    try {
      const r: RouteAnswer = await route.run({
        env,
        db,
        key,
        body: parsed,
        now,
        idempotencyKey: idem,
        requestId,
        params,
        path: `${path}${query}`,
        query: url.searchParams,
        bodySha256Hex: bodyHash,
        waitUntil: (p) => ctx.waitUntil(p),
      });
      out = { status: r.status, code: null, body: r.body };
      appId = r.appId ?? null;
      wrote = r.wrote === true;
    } catch (err) {
      // The app a refused call named, for `platform_calls` (its id as the path gave it; none when the path has none).
      appId = params.appId ?? null;
      if (err instanceof RpcRefusal) out = { status: RPC_HTTP_STATUS[err.code], code: err.code, body: { error: err.message.slice(0, 500), code: err.code } };
      else if (err instanceof PlatformRefusal) out = { status: err.status, code: err.code, body: { error: err.message.slice(0, 500), code: err.code, ...err.extra }, headers: err.headers };
      else {
        log({ event: 'platform', requestId, outcome: 'error', code: 'route_failed', platformKeyId: keyId, endpoint: route.path }, 'error');
        out = refusal('internal', 'Internal error');
      }
    }
  }
  // F1: a valid self-revoke that didn't stop the key (a race lost, a failure) is charged to the key's windows after all.
  if (validRevoke && !wrote) {
    try {
      await kobj.hit([...PLATFORM_WINDOWS.key], now);
    } catch {
      log({ event: 'platform', requestId, outcome: 'error', code: 'key_limiter_failed', platformKeyId: keyId }, 'error');
    }
  }
  // A removal that changed nothing gets its breaker slot back (no tokens are ever given back, D935).
  if (settle && settle.breaker && !wrote) {
    try {
      await consoleObj(env).platformSettle({ org: key.org_id, at: settle.at, breaker: true });
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
    // F11: an unrecorded call gives its key charge and last-used marker back. A read is never answered unrecorded; a
    // write that committed is answered (its ledger row records it).
    await undoCharge();
    if (!wrote) out = refusal('internal', 'Internal error');
  }
  return finish(out);
}
