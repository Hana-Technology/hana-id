// The admin Worker's client of the watchdog's status endpoint (apps/watchdog/README.md "Status endpoint"; batch C14,
// D83): `GET /status`, `GET /alerts`, `GET /actions` and `POST /alerts/:id/ack`, server-side only. The bearer
// `WATCHDOG_STATUS_TOKEN` goes in the `Authorization` header of these calls and nowhere else: never into a response, a
// log line or an error message (the browser never sees it, D330).
//
// The watchdog runs on its own Cloudflare account and is a party this Worker must survive: every call has a timeout
// that covers the body too, every answer a size cap (by Content-Length, then while streaming), a redirect is refused
// rather than followed (it would carry the bearer to another origin), and nothing of an error answer is passed on but
// its status class. What comes back is parsed JSON; monitoring.ts reduces it to bounded plain text before the SPA
// sees it.

import type { Env } from './env.ts';
import type { AdminErrorCode } from './http.ts';
import { log } from './log.ts';

/** Per-route caps on the watchdog's answers (bytes). `/alerts` carries every delivery of each alert (re-sends add up). */
export const WATCHDOG_LIMITS = {
  status: 1024 * 1024,
  alerts: 2 * 1024 * 1024,
  actions: 512 * 1024,
  ack: 64 * 1024,
} as const;

/** The deadline of one call, body included. Mutable for the tests (as `outbound` is for email). */
export const watchdogTiming = { timeoutMs: 8_000 };

/** The token the watchdog accepts (apps/watchdog/src/status.ts MIN_TOKEN_LENGTH). */
const MIN_TOKEN_LENGTH = 32;

export type WatchdogFailure = Extract<AdminErrorCode, 'watchdog_unconfigured' | 'watchdog_unavailable' | 'watchdog_timeout' | 'watchdog_too_large' | 'watchdog_bad_answer' | 'watchdog_unauthorized'>;

export type WatchdogAnswer = { ok: true; status: number; body: unknown } | { ok: false; code: WatchdogFailure };

/** The watchdog's origin from WATCHDOG_URL, or null unless it is an https origin exactly (the manifest's rule). */
export function watchdogOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.origin !== raw) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const usableToken = (t: string | undefined): t is string => typeof t === 'string' && t.length >= MIN_TOKEN_LENGTH && t.length <= 512 && /^[\x21-\x7e]+$/u.test(t);

/** Whether this Worker can call the watchdog at all (both the origin and the token are set and well-formed). */
export const watchdogConfigured = (env: Pick<Env, 'WATCHDOG_URL' | 'WATCHDOG_STATUS_TOKEN'>): boolean => watchdogOrigin(env.WATCHDOG_URL) !== null && usableToken(env.WATCHDOG_STATUS_TOKEN);

class Timeout extends Error {
  constructor() {
    super('timeout');
    this.name = 'Timeout';
  }
}
class TooLarge extends Error {
  constructor() {
    super('too large');
    this.name = 'TooLarge';
  }
}

/** The body as text, refusing more than `max` bytes (declared or streamed). */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared.trim()) && Number(declared.trim()) > max) {
    await res.body?.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all);
}

/**
 * One call. `route` names it in logs (`status`, `alerts`, `actions`, `ack`); `path` starts with `/` and is built by the
 * caller from validated parts only. The watchdog's 4xx answers that mean something to the caller (404, 409, 400) come
 * back as `ok: true` with their status; 401 is `watchdog_unauthorized`, 5xx `watchdog_unavailable`.
 */
export async function callWatchdog(env: Env, route: keyof typeof WATCHDOG_LIMITS, path: string, init: { method?: 'GET' | 'POST'; body?: unknown; requestId?: string } = {}): Promise<WatchdogAnswer> {
  const origin = watchdogOrigin(env.WATCHDOG_URL);
  const token = env.WATCHDOG_STATUS_TOKEN;
  if (!origin || !usableToken(token)) return { ok: false, code: 'watchdog_unconfigured' };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, watchdogTiming.timeoutMs);
  });
  const fail = (code: WatchdogFailure, status?: number): WatchdogAnswer => {
    log({ event: 'watchdog_call', route, requestId: init.requestId, outcome: 'error', code, ...(status !== undefined ? { status } : {}) }, code === 'watchdog_unconfigured' ? 'warn' : 'error');
    return { ok: false, code };
  };
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const work = (async (): Promise<WatchdogAnswer> => {
      const res = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        return fail('watchdog_bad_answer', res.status);
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        return fail('watchdog_unauthorized', 401);
      }
      if (res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        // The watchdog answers 503 `not_configured` when it has no token of its own.
        return fail(res.status === 503 ? 'watchdog_unconfigured' : 'watchdog_unavailable', res.status);
      }
      const text = await readCapped(res, WATCHDOG_LIMITS[route]);
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return fail('watchdog_bad_answer', res.status);
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail('watchdog_bad_answer', res.status);
      log({ event: 'watchdog_call', route, requestId: init.requestId, outcome: res.ok ? 'ok' : 'rejected', status: res.status });
      return { ok: true, status: res.status, body };
    })();
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (err instanceof Timeout || controller.signal.aborted) return fail('watchdog_timeout');
    if (err instanceof TooLarge) return fail('watchdog_too_large');
    if (err instanceof TypeError && /decode|utf-8|encoded/iu.test(String((err as Error).message))) return fail('watchdog_bad_answer');
    return fail('watchdog_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
