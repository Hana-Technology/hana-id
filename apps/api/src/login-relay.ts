// The login relay (docs/batch-b-spec.md, "Relay Durable Object"): how a Google ID token gets from the login callback
// page (authOrigin) back to the vault (vaultOrigin) without trusting `window.opener` across Google's pages. One
// LoginRelay object per relayId holds at most one value, written once and read once, for 120 s. The value is
// AES-GCM ciphertext under `relayKey`, which only the vault and the login popup hold: the API never sees the token or
// its nonce, and can't put a token of its own in the slot. Reading needs `relayReadKey` (relayId = b64url(sha256 of
// it)), which never leaves the vault, so whoever learns relayId (it is also the OAuth `state`) can't consume the slot.
//
// A login that offers email (build plan batch 8b) also uses follow-up slots (core links.ts `followSlot`): the vault
// writes its notices (google-match's screens, link banners) and the popup its answers, each slot write-once and
// read-once like the first, each value under the same relayKey with the slot's own AAD.
//
//   POST /v1/login-relay/<relayId>            {iv, ct} (base64url)       authOrigin, vaultOrigin 204 | 409 relay_used
//   GET  /v1/login-relay/<relayId>?wait=1..25  x-hana-relay-key: <b64url> vaultOrigin, authOrigin
//        200 {iv, ct, serverTimeMs, heldMs} (consumed) | 204 (still empty after `wait` s) | 410 relay_gone | 403 relay_forbidden
//
// Not app-gated (no x-hana-key): the callback page doesn't know the app. Rate-limited per IP. Bodies, keys and relay
// ids are never logged.
import { DurableObject } from 'cloudflare:workers';
import { base64UrlDecode, base64UrlEncode, sha256 } from './bytes.ts';
import type { Env } from './env.ts';
import { type Headers_, corsHeaders, json, readJson } from './http.ts';
import { ipSubject } from './ip.ts';
import { log } from './log.ts';
import { type HanaPage, RELAY_KEY_HEADER, hanaPage } from './origins.ts';

export const LOGIN_RELAY_PREFIX = '/v1/login-relay/';
/** The endpoint as every log line names it: never with the relayId, which is also the OAuth `state`. */
export const LOGIN_RELAY_ENDPOINT = '/v1/login-relay';

/** A request path as it may be logged: a login relay path loses its relayId. */
export function loggedEndpoint(pathname: string): string {
  return pathname.startsWith(LOGIN_RELAY_PREFIX) ? LOGIN_RELAY_ENDPOINT : pathname;
}
/** A written value lives this long, then a tombstone answers 410 for as long again, then the object is empty. */
export const RELAY_TTL_MS = 120_000;
export const RELAY_TOMBSTONE_MS = 120_000;
export const RELAY_MAX_BODY = 8 * 1024;
export const RELAY_MAX_WAIT_S = 25;
export const RELAY_WRITES_PER_IP_MINUTE = 10;
export const RELAY_READS_PER_IP_MINUTE = 120;
/** b64url(sha256(relayReadKey)): 43 characters. */
export const RELAY_ID_RE = /^[A-Za-z0-9_-]{43}$/u;
const IV_BYTES = 12;
/** AES-GCM tag. */
const MIN_CT_BYTES = 16;
const MINUTE = 60_000;

type Slot =
  | { state: 'full'; iv: string; ct: string; writtenAt: number }
  | { state: 'consumed'; writtenAt: number; consumedAt: number }
  | { state: 'expired'; expiredAt: number };

/** `heldMs`: how long the value sat in the slot before this read took it (the object's clock). */
export type RelayRead = { kind: 'value'; iv: string; ct: string; heldMs: number } | { kind: 'empty' } | { kind: 'gone' } | { kind: 'forbidden' };

/** Whether `readKey` (b64url, 32 bytes) is the read key of `relayId`. */
export async function readKeyMatches(relayId: string, readKey: string | null): Promise<boolean> {
  if (!readKey || !/^[A-Za-z0-9_-]{43}$/u.test(readKey)) return false;
  let key: Uint8Array;
  try {
    key = base64UrlDecode(readKey);
  } catch {
    return false;
  }
  return key.length === 32 && base64UrlEncode(await sha256(key)) === relayId;
}

/**
 * One relay slot. Storage is the SQLite-backed synchronous KV API, so a check and the write that follows it are
 * atomic inside the object (two writes can't both pass, two reads can't both consume). Responses leave the object
 * only once its writes are durable (output gates), so a consumed value can't be read again after a restart.
 */
export class LoginRelay extends DurableObject<Env> {
  /** Readers waiting for the first write (long poll). */
  private readonly waiters = new Set<() => void>();

  /** Stores the value if the slot was never written; false if it already holds one, or held one. */
  async write(iv: string, ct: string, now: number = Date.now()): Promise<boolean> {
    const kv = this.ctx.storage.kv;
    if (kv.get<Slot>('slot') !== undefined) return false;
    kv.put('slot', { state: 'full', iv, ct, writtenAt: now } satisfies Slot);
    await this.ctx.storage.setAlarm(now + RELAY_TTL_MS);
    for (const wake of [...this.waiters]) wake();
    return true;
  }

  /**
   * Consumes the value, with the read key checked first (a wrong key leaves the slot as it is). Waits up to `waitMs`
   * for a write when the slot is still empty.
   */
  async read(relayId: string, readKey: string | null, waitMs: number): Promise<RelayRead> {
    if (!(await readKeyMatches(relayId, readKey))) return { kind: 'forbidden' };
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      const got = this.take(Date.now());
      const left = deadline - Date.now();
      if (got.kind !== 'empty' || left <= 0) return got;
      await this.nextWrite(left);
    }
  }

  /** Value written 120 s ago (read or not): keep a tombstone for 120 s more. Tombstone: delete everything. */
  override async alarm(): Promise<void> {
    const slot = this.ctx.storage.kv.get<Slot>('slot');
    if (!slot) return;
    if (slot.state === 'expired') {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    this.ctx.storage.kv.put('slot', { state: 'expired', expiredAt: now } satisfies Slot);
    await this.ctx.storage.setAlarm(now + RELAY_TOMBSTONE_MS);
  }

  private take(now: number): RelayRead {
    const kv = this.ctx.storage.kv;
    const slot = kv.get<Slot>('slot');
    if (!slot) return { kind: 'empty' };
    // Past its TTL but the alarm hasn't run yet: as good as gone (the alarm still moves it to the tombstone).
    if (slot.state !== 'full' || now >= slot.writtenAt + RELAY_TTL_MS) return { kind: 'gone' };
    kv.put('slot', { state: 'consumed', writtenAt: slot.writtenAt, consumedAt: now } satisfies Slot);
    return { kind: 'value', iv: slot.iv, ct: slot.ct, heldMs: Math.max(0, now - slot.writtenAt) };
  }

  /** Resolves on the next write, or after `ms`. */
  private nextWrite(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }
}

// ---- Worker side ----

const RELAY_ALLOW_HEADERS = `content-type, ${RELAY_KEY_HEADER}`;
const RELAY_METHODS = 'GET, POST, OPTIONS';
/**
 * The callback page and the email step (authOrigin) write, and so does the vault, whose follow-up notices the popup
 * reads (batch 8b); the vault, or the export window and the popup on authOrigin, read. A writer can't forge a value:
 * each is AES-GCM under the login's relayKey, which only the vault and its popup hold.
 */
const WRITERS: readonly HanaPage[] = ['auth', 'vault'];
const READERS: readonly HanaPage[] = ['vault', 'auth'];

const isB64url = (v: unknown, min: number, max: number): v is string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(v)) return false;
  try {
    const n = base64UrlDecode(v).length;
    return n >= min && n <= max;
  } catch {
    return false;
  }
};

/** `{iv, ct}`: exactly these keys, a 12-byte IV and a ciphertext with at least the tag. */
function toRelayValue(body: unknown): { iv: string; ct: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('iv') || !keys.includes('ct')) return null;
  const { iv, ct } = body as Record<string, unknown>;
  return isB64url(iv, IV_BYTES, IV_BYTES) && isB64url(ct, MIN_CT_BYTES, RELAY_MAX_BODY) ? { iv, ct } : null;
}

/** `wait`: absent → 0 (answer at once), else an integer 1..25 seconds; null when malformed. */
function waitSeconds(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^\d{1,2}$/u.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= RELAY_MAX_WAIT_S ? n : null;
}

/** POST/GET/OPTIONS on /v1/login-relay/<relayId>. */
export async function handleLoginRelay(request: Request, env: Env, requestId: string): Promise<Response> {
  const started = Date.now();
  const method = request.method;
  let cors: Headers_ = {};
  const reply = (status: number, body: Record<string, unknown> | null, extra: Headers_ = {}): Response => {
    const code = typeof body?.code === 'string' ? body.code : undefined;
    // Never the body, the key or the relay id.
    log(
      { event: 'request', requestId, endpoint: LOGIN_RELAY_ENDPOINT, method, outcome: status < 400 ? 'ok' : status >= 500 ? 'error' : 'rejected', status, code, latencyMs: Date.now() - started },
      status >= 500 ? 'error' : 'info',
    );
    const headers = { ...cors, 'x-request-id': requestId, ...extra };
    if (body === null) return new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } });
    return json(status, { ...body, requestId }, headers);
  };
  const fail = (status: number, code: string, error: string, extra: Headers_ = {}): Response => reply(status, { error, code }, extra);

  const origin = request.headers.get('origin');
  const page = hanaPage(env, origin);
  if (method === 'OPTIONS') {
    if (!page || !origin) return new Response(null, { status: 403, headers: { vary: 'Origin' } });
    return new Response(null, { status: 204, headers: corsHeaders(origin, RELAY_ALLOW_HEADERS, RELAY_METHODS) });
  }
  if (method !== 'GET' && method !== 'POST') return fail(405, 'method_not_allowed', 'Method not allowed', { allow: RELAY_METHODS });

  const relayId = new URL(request.url).pathname.slice(LOGIN_RELAY_PREFIX.length);
  const write = method === 'POST';
  if (!page || !origin || !(write ? WRITERS : READERS).includes(page)) return fail(403, 'origin_not_allowed', 'Origin not allowed');
  cors = corsHeaders(origin, RELAY_ALLOW_HEADERS, RELAY_METHODS);
  if (!RELAY_ID_RE.test(relayId)) return fail(400, 'bad_relay_id', 'relayId must be 43 base64url characters');

  try {
    const ip = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`ip:${ipSubject(request.headers.get('cf-connecting-ip'))}`));
    const hit = await ip.hit([
      write ? { name: 'relay:write:minute', windowMs: MINUTE, max: RELAY_WRITES_PER_IP_MINUTE } : { name: 'relay:read:minute', windowMs: MINUTE, max: RELAY_READS_PER_IP_MINUTE },
    ]);
    if (!hit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }

  // One object per relayId, created wherever it is first used (no location hint: writer and reader are one user).
  const slot = env.LOGIN_RELAY.get(env.LOGIN_RELAY.idFromName(relayId));
  if (write) {
    const parsed = await readJson(request, RELAY_MAX_BODY);
    if (!parsed.ok) return fail(parsed.status, 'bad_request', parsed.error);
    const value = toRelayValue(parsed.body);
    if (!value) return fail(400, 'bad_request', 'Body must be {"iv", "ct"} in base64url (12-byte iv)');
    let stored: boolean;
    try {
      stored = await slot.write(value.iv, value.ct);
    } catch {
      return fail(503, 'relay_unavailable', 'The relay is unavailable, try again');
    }
    return stored ? reply(204, null) : fail(409, 'relay_used', 'This relay slot was already written');
  }

  const wait = waitSeconds(new URL(request.url).searchParams.get('wait'));
  if (wait === null) return fail(400, 'bad_request', `wait must be 1 to ${RELAY_MAX_WAIT_S} seconds`);
  let got: RelayRead;
  try {
    got = await slot.read(relayId, request.headers.get(RELAY_KEY_HEADER), wait * 1000);
  } catch {
    return fail(503, 'relay_unavailable', 'The relay is unavailable, try again');
  }
  switch (got.kind) {
    case 'value':
      // heldMs is a duration (no timestamp of the write): 0 while the vault long-polls, more when it read late.
      return reply(200, { iv: got.iv, ct: got.ct, serverTimeMs: Date.now(), heldMs: got.heldMs });
    case 'empty':
      return reply(204, null);
    case 'gone':
      return fail(410, 'relay_gone', 'This relay slot was already read or has expired');
    case 'forbidden':
      return fail(403, 'relay_forbidden', 'Missing or wrong relay read key');
  }
}
