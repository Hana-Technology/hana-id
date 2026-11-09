// The System status page's outbound reads (D425; apps/admin/README.md "System status"), each counted: the public build
// reads `deploy-check` makes (scripts/lib/deploy-check.ts: `GET /v1/health`, `/.well-known/hana-build`, the first line
// of `/vault.js`, the `<meta name="hana-build">` of `/login` and the console SPA, `GET /v1/email/health`) and one NEAR
// RPC `block` per endpoint. Every read has a deadline that covers the body, reads at most a small prefix of it, follows
// no redirect, sends no credential and passes nothing of an answer on but its status, its timing and a well-formed
// build id (or block height and time). A read never throws.
import { BUILD_PATH, ISSUER_HEALTH_PATH, parseBuildId, parseBuildMeta, parseVaultBanner } from '@hana-id/env/build-id';

/** A read's deadline, body included. Mutable for the tests. */
export const probeTiming = { timeoutMs: 5_000 };
/** Slower than this is amber ("slow"). */
export const SLOW_MS = 2_000;
/** The most read of a JSON or HTML answer (deploy-check's BODY_LIMIT); of `/vault.js`, only its first line. */
export const BODY_LIMIT = 16_384;
export const BANNER_LIMIT = 256;
/** A NEAR `block` answer carries the chunk headers: a few KB on testnet, capped well above that. */
export const NEAR_BODY_LIMIT = 256 * 1024;

/** The outbound calls of one status read, by kind: the page's subrequest budget (D425; Workers Free: 50 a request). */
export class CallCount {
  readonly byKind: Record<string, number> = {};
  total = 0;
  take(kind: 'fetch' | 'rpc' | 'hyperdrive' | 'r2' | 'watchdog'): void {
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    this.total += 1;
  }
}

export type ProbeFailure = 'timeout' | 'unreachable' | 'redirect' | 'http_error' | 'too_large' | 'bad_answer';

export interface BuildRead {
  ok: boolean;
  /** HTTP status, null when there was no answer. */
  status: number | null;
  latencyMs: number;
  /** A well-formed build id from the answer, else null (unstamped, or not read). */
  build: string | null;
  failure: ProbeFailure | null;
}

export type BuildReadKind = 'json' | 'vault-js' | 'html-meta';

export interface BuildTarget {
  id: string;
  url: string;
  kind: BuildReadKind;
}

class Timeout extends Error {}
class TooLarge extends Error {}

/** Up to `max` bytes of the body as text; past it: `TooLarge` (`cut`: false), or the prefix (`cut`: true, the banner). */
async function readPrefix(res: Response, max: number, cut: boolean): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      if (!cut && total > max) throw new TooLarge();
      break;
    }
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all.subarray(0, Math.min(total, max)));
}

/** One deadline-bound fetch: the answer's handling runs inside the deadline too. */
async function timed<T>(url: string, init: RequestInit, handle: (res: Response) => Promise<T>): Promise<{ value: T; latencyMs: number }> {
  const controller = new AbortController();
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Timeout());
    }, probeTiming.timeoutMs);
  });
  try {
    const work = (async () => handle(await fetch(url, { ...init, redirect: 'manual', signal: controller.signal })))();
    const value = await Promise.race([work, deadline]);
    return { value, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function failureOf(err: unknown, aborted: boolean): ProbeFailure {
  if (err instanceof Timeout || aborted) return 'timeout';
  if (err instanceof TooLarge) return 'too_large';
  return 'unreachable';
}

/** The build read of one deployed piece, as `deploy-check` reads it. */
export async function readBuild(t: BuildTarget, calls: CallCount): Promise<BuildRead> {
  calls.take('fetch');
  const start = Date.now();
  try {
    const { value, latencyMs } = await timed(t.url, { method: 'GET', headers: { accept: t.kind === 'json' ? 'application/json' : '*/*' } }, async (res) => {
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status, build: null, failure: 'redirect' as const };
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, status: res.status, build: null, failure: 'http_error' as const };
      }
      const text = await readPrefix(res, t.kind === 'vault-js' ? BANNER_LIMIT : BODY_LIMIT, t.kind === 'vault-js');
      let build: string | null = null;
      if (t.kind === 'json') {
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          return { ok: false, status: res.status, build: null, failure: 'bad_answer' as const };
        }
        build = parseBuildId((body as { build?: unknown } | null)?.build)?.id ?? null;
      } else if (t.kind === 'vault-js') build = parseVaultBanner(text)?.id ?? null;
      else build = parseBuildMeta(text)?.id ?? null;
      return { ok: true, status: res.status, build, failure: null };
    });
    return { ...value, latencyMs };
  } catch (err) {
    return { ok: false, status: null, latencyMs: Date.now() - start, build: null, failure: failureOf(err, false) };
  }
}

export interface NearRead {
  ok: boolean;
  latencyMs: number;
  height: number | null;
  /** The final block's timestamp (ms). */
  blockAtMs: number | null;
  failure: ProbeFailure | null;
}

/** One `block` at `finality: final`: is the endpoint up, and how far behind is it? */
export async function readNear(url: string, calls: CallCount): Promise<NearRead> {
  calls.take('fetch');
  const start = Date.now();
  try {
    const { value, latencyMs } = await timed(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'hana-status', method: 'block', params: { finality: 'final' } }) },
      async (res) => {
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, height: null, blockAtMs: null, failure: 'redirect' as const };
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return { ok: false, height: null, blockAtMs: null, failure: 'http_error' as const };
        }
        let body: { result?: { header?: { height?: unknown; timestamp_nanosec?: unknown; timestamp?: unknown } }; error?: unknown } | null;
        try {
          body = JSON.parse(await readPrefix(res, NEAR_BODY_LIMIT, false)) as typeof body;
        } catch (err) {
          if (err instanceof TooLarge) throw err;
          return { ok: false, height: null, blockAtMs: null, failure: 'bad_answer' as const };
        }
        const header = body?.result?.header;
        const height = header?.height;
        const nanos = typeof header?.timestamp_nanosec === 'string' && /^\d{1,25}$/u.test(header.timestamp_nanosec) ? header.timestamp_nanosec : null;
        if (!header || body?.error || !Number.isSafeInteger(height) || nanos === null) return { ok: false, height: null, blockAtMs: null, failure: 'bad_answer' as const };
        return { ok: true, height: height as number, blockAtMs: Number(BigInt(nanos) / 1_000_000n), failure: null };
      },
    );
    return { ...value, latencyMs };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, height: null, blockAtMs: null, failure: failureOf(err, false) };
  }
}

/** The pieces' build reads for this env, from the Worker's vars (an absent piece is absent here). */
export function buildTargets(env: { API_URL?: string; VAULT_ORIGIN?: string; AUTH_ORIGIN?: string; EMAIL_ISSUER_URL?: string; CONSOLE_ORIGIN: string; CONSOLE_AUTH_ORIGIN?: string; FILES_ORIGIN: string }): BuildTarget[] {
  const out: BuildTarget[] = [];
  const base = (u: string | undefined): string | null => {
    if (!u) return null;
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? u.replace(/\/+$/u, '') : null;
    } catch {
      return null;
    }
  };
  const api = base(env.API_URL);
  if (api) out.push({ id: 'api', url: `${api}/v1/health`, kind: 'json' });
  const vault = base(env.VAULT_ORIGIN);
  if (vault) out.push({ id: 'vault', url: `${vault}${BUILD_PATH}`, kind: 'json' }, { id: 'vault-bundle', url: `${vault}/vault.js`, kind: 'vault-js' });
  const auth = base(env.AUTH_ORIGIN);
  if (auth) out.push({ id: 'auth', url: `${auth}${BUILD_PATH}`, kind: 'json' }, { id: 'auth-pages', url: `${auth}/login`, kind: 'html-meta' });
  const issuer = base(env.EMAIL_ISSUER_URL);
  if (issuer) out.push({ id: 'issuer', url: `${issuer}${ISSUER_HEALTH_PATH}`, kind: 'json' });
  const consoleOrigin = base(env.CONSOLE_ORIGIN);
  if (consoleOrigin) out.push({ id: 'console', url: `${consoleOrigin}${BUILD_PATH}`, kind: 'json' }, { id: 'console-spa', url: `${consoleOrigin}/`, kind: 'html-meta' });
  const consoleAuth = base(env.CONSOLE_AUTH_ORIGIN);
  if (consoleAuth) out.push({ id: 'console-auth', url: `${consoleAuth}${BUILD_PATH}`, kind: 'json' });
  const files = base(env.FILES_ORIGIN);
  if (files) out.push({ id: 'files', url: `${files}${BUILD_PATH}`, kind: 'json' });
  return out;
}
