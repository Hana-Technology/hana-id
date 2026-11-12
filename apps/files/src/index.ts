// hana-id-files-<env> (docs/batch-c-spec.md "Topology", "Other app settings, name and logo", "Response headers"): the
// thin Worker of `files.origin`, which serves app logos from R2 and nothing else. The console writes them (batch C11:
// re-encoded through the Images binding to a 256 × 256 PNG, content-addressed); this Worker only reads, and checks
// every object again before serving it, so a bad object (a direct bucket write, a compromised console) is a 404, never
// a document on a Hana origin:
//
// - only `GET` and `HEAD` of `/logos/<app id>/<64 hex>.png` on FILES_ORIGIN; any other host or path is 404, any other
//   method 405;
// - the object must exist, be at most LOGO_MAX_BYTES, have `contentType: image/png`, start with the PNG signature and
//   hash to the sha256 its key names (the console's keys are content-addressed);
// - the answer carries exactly the spec's headers: `image/png`, `nosniff`, a `sandbox` CSP, cross-origin CORP (the
//   auth pages and the console show it), inline disposition, a year's immutable caching and `no-referrer`. No cookie.
// - the mail logo (D685): `GET`/`HEAD` of `@hana-id/brand/mail-logo` MAIL_LOGO_PATH, bytes built into the Worker (no
//   R2), with the logo headers. It is the one image the designed mails load: its URL is the same for every recipient
//   and mail (no query, no token), a query string is ignored, and the Worker logs nothing for it (no line at all; the
//   platform's invocation logs are off for this Worker, so no IP, user agent or URL is kept);
// - one more path, `GET`/`HEAD /.well-known/hana-build`: the build id this Worker was deployed with (`{"build": <id> |
//   null}`, the HANA_BUILD var the shared deploy wrapper sets; D384, D406) for `deploy-check`, as JSON under the error
//   answers' headers (a sandbox CSP, `no-store`), so it runs and is kept nowhere.
//
// R2 bindings can't be read-only, so "read only by code" is a code rule with a source test: this Worker calls `get`
// on LOGOS and nothing else (scripts/test/files.test.ts).
import { MAIL_LOGO_PATH, MAIL_LOGO_PNG_BASE64 } from '@hana-id/brand/mail-logo';
import { BUILD_PATH, buildBody } from '@hana-id/env/build-id';
import type { Env } from './env.ts';
import { LOGO_HEADERS, LOGO_MAX_BYTES, LOGO_PATH_RE, MAIL_LOGO_HEADERS, PNG_SIGNATURE } from './rules.ts';

export type { Env } from './env.ts';
export { LOGO_HEADERS, LOGO_MAX_BYTES, LOGO_PATH_RE, MAIL_LOGO_HEADERS, PNG_SIGNATURE } from './rules.ts';

/** The mail logo's bytes, decoded once per isolate. */
const MAIL_LOGO = Uint8Array.from(atob(MAIL_LOGO_PNG_BASE64), (c) => c.charCodeAt(0));

/** Every other answer: plain text that runs, loads and frames nothing, and is never cached (a logo may appear later). */
const ERROR_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/plain; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
});

const notFound = (head: boolean): Response => new Response(head ? null : 'Not found\n', { status: 404, headers: ERROR_HEADERS });

function log(fields: { event: string; outcome: 'rejected' | 'error'; code: string }, level: 'warn' | 'error'): void {
  const text = JSON.stringify({ level, at: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(text);
  else console.warn(text);
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Whether the object's bytes are a logo the console wrote under this key. */
async function isServable(obj: R2ObjectBody, sha256: string): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; code: string }> {
  const refuse = async (code: string) => {
    await obj.body.cancel().catch(() => {});
    return { ok: false as const, code };
  };
  if (obj.size > LOGO_MAX_BYTES) return refuse('too_large');
  if (obj.httpMetadata?.contentType !== 'image/png') return refuse('not_png_type');
  const bytes = await obj.arrayBuffer();
  const head = new Uint8Array(bytes, 0, Math.min(PNG_SIGNATURE.length, bytes.byteLength));
  if (head.length !== PNG_SIGNATURE.length || !head.every((b, i) => b === PNG_SIGNATURE[i])) return { ok: false, code: 'not_png' };
  if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== sha256) return { ok: false, code: 'hash_mismatch' };
  return { ok: true, bytes };
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const head = request.method === 'HEAD';
  const url = new URL(request.url);
  // Host dispatch: files.origin only (a workers.dev or preview URL of this Worker serves nothing).
  if (url.origin !== env.FILES_ORIGIN) return notFound(head);
  if (request.method !== 'GET' && !head) return new Response('Method not allowed\n', { status: 405, headers: { ...ERROR_HEADERS, allow: 'GET, HEAD' } });
  if (url.pathname === BUILD_PATH) return new Response(head ? null : buildBody(env.HANA_BUILD), { status: 200, headers: { ...ERROR_HEADERS, 'content-type': 'application/json; charset=utf-8' } });
  // The mail logo: no lookup, no log line, whatever the query string.
  if (url.pathname === MAIL_LOGO_PATH) return new Response(head ? null : MAIL_LOGO, { status: 200, headers: { ...MAIL_LOGO_HEADERS, 'content-length': String(MAIL_LOGO.byteLength) } });
  // The path only: a query string is ignored (it can't name another object), never part of the key.
  const m = LOGO_PATH_RE.exec(url.pathname);
  if (!m) return notFound(head);
  const [, key, sha256] = m as unknown as [string, string, string];
  let obj: R2ObjectBody | null;
  try {
    obj = await env.LOGOS.get(key);
  } catch {
    log({ event: 'logo', outcome: 'error', code: 'r2_unavailable' }, 'error');
    return new Response(head ? null : 'Unavailable\n', { status: 503, headers: ERROR_HEADERS });
  }
  if (!obj) return notFound(head);
  const check = await isServable(obj, sha256);
  if (!check.ok) {
    // An object under a logo key that isn't one is a bucket problem worth an operator's look; it is never served.
    log({ event: 'logo', outcome: 'rejected', code: check.code }, 'warn');
    return notFound(head);
  }
  return new Response(head ? null : check.bytes, { status: 200, headers: { ...LOGO_HEADERS, 'content-length': String(check.bytes.byteLength) } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      log({ event: 'files_error', outcome: 'error', code: 'internal' }, 'error');
      return new Response('Something went wrong\n', { status: 500, headers: ERROR_HEADERS });
    }
  },
} satisfies ExportedHandler<Env>;
