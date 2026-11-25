// Journear Passport platform API: sign and send requests from your backend. Public sample code: copy it.
// TypeScript, an ES module, no dependencies. It needs WebCrypto, fetch and AbortSignal.timeout: Node 22.18 or later runs
// it as it is (`node`'s built-in type stripping), Node 20 through a TypeScript build step (tsc, tsx or your bundler);
// other server runtimes with those APIs work too.

/** A WebCrypto private key (the DOM's and Node's types both name it this way). */
export type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/** What your backend needs for one environment. Keep these in your configuration, never in code. */
export interface PlatformConfig {
  /** The env's API base URL, as Journear gives it (`https://…`; a trailing slash is dropped). */
  apiBase: string;
  /** The env's name and contract account: lines 2 and 3 of every signed message (Journear gives both). */
  envName: string;
  signerAccount: string;
  /** Your platform key's id (`pkc_…`), shown in the partner portal once the key is registered. */
  keyId: string;
  /** Your private key, imported once at start-up (importPrivateKeyPem). Never log it. */
  privateKey: SigningKey;
  /** Optional: another fetch (a proxy, a test) and another clock (unix milliseconds). */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PlatformRequest {
  method: 'GET' | 'POST';
  /** The path and, for a GET, its query, exactly as sent: `/v1/platform/apps?scopeId=…`. */
  path: string;
  /** A POST's JSON body (`{}` when there is nothing to send). Serialised once, so every retry sends the same bytes. */
  body?: Record<string, unknown>;
  /** Every write: one key per operation, stored with it, resent unchanged on every retry. */
  idempotencyKey?: string;
}

export interface PlatformAnswer {
  status: number;
  /** Success: the answer's fields. Failure: `{ error, code, requestId, … }`. Match on `code`, never on `error`. */
  body: Record<string, unknown>;
  /** The API's request id for this answer: log it; Journear support asks for it. */
  requestId: string | null;
}

const PATH_RE = /^\/v1\/platform(\/[A-Za-z0-9_-]+)+(\?[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}(&[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}){0,3})?$/;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // slice(): a copy on its own ArrayBuffer, as WebCrypto's TypeScript types want.
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice())));
}

/** A fresh Idempotency-Key for a new operation (22 characters). Store it with the operation before the first send. */
export function newIdempotencyKey(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Imports a PKCS #8 PEM private key (`openssl genpkey` writes one) for signing only; the key can't be exported again. */
export async function importPrivateKeyPem(pem: string): Promise<SigningKey> {
  const m = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error('Expected a PKCS #8 PEM private key');
  const der = Uint8Array.from(atob(m[1]!.replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/** The signed message: ten lines joined by "\n", no trailing newline. */
export function platformMessage(p: {
  envName: string;
  signerAccount: string;
  method: string;
  path: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  idempotencyKey: string;
  bodySha256Hex: string;
}): string {
  const lines = ['journear-platform-v1', p.envName, p.signerAccount, p.method, p.path, p.keyId, p.timestamp, p.nonce, p.idempotencyKey, p.bodySha256Hex];
  if (lines.some((l) => /[\r\n]/.test(l))) throw new Error('A line of the signed message holds a line break');
  return lines.join('\n');
}

/**
 * A KMS's DER signature (SEQUENCE { INTEGER r, INTEGER s }) as the 64 bytes r ‖ s the API wants. WebCrypto already
 * gives r ‖ s; use this only for a KMS or library that answers DER.
 */
export function derToRaw(der: Uint8Array): Uint8Array {
  const fail = (): never => {
    throw new Error('Not a DER ECDSA P-256 signature');
  };
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) fail();
  let at = 2;
  const int = (): Uint8Array => {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1]!;
    if (len < 1 || len > 33 || at + 2 + len > der.length) fail();
    let v = der.subarray(at + 2, at + 2 + len);
    at += 2 + len;
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > 32) fail();
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const raw = new Uint8Array(64);
  raw.set(int(), 0);
  raw.set(int(), 32);
  if (at !== der.length) fail();
  return raw;
}

/** The headers for one attempt: a fresh nonce and timestamp each time (or the given ones, for test vectors). */
export async function signHeaders(
  cfg: Pick<PlatformConfig, 'envName' | 'signerAccount' | 'keyId' | 'privateKey'>,
  r: { method: 'GET' | 'POST'; path: string; body: Uint8Array; idempotencyKey?: string | undefined; timestampMs: number; nonce?: string },
): Promise<Record<string, string>> {
  if (!PATH_RE.test(r.path)) throw new Error(`Not a platform path: ${r.path}`);
  if (r.method === 'GET' && (r.body.length > 0 || r.idempotencyKey !== undefined)) throw new Error('A GET has no body and no Idempotency-Key');
  if (r.method === 'POST' && r.path.includes('?')) throw new Error('A POST takes no query');
  const timestamp = String(r.timestampMs);
  const nonce = r.nonce ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const message = platformMessage({
    envName: cfg.envName,
    signerAccount: cfg.signerAccount,
    method: r.method,
    path: r.path,
    keyId: cfg.keyId,
    timestamp,
    nonce,
    idempotencyKey: r.idempotencyKey ?? '',
    bodySha256Hex: await sha256Hex(r.body),
  });
  // WebCrypto's ECDSA hashes the message with SHA-256 itself and answers r ‖ s (64 bytes): what the API wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cfg.privateKey, enc.encode(message)));
  const headers: Record<string, string> = {
    'Journear-Key-Id': cfg.keyId,
    'Journear-Timestamp': timestamp,
    'Journear-Nonce': nonce,
    'Journear-Signature': b64url(sig),
  };
  if (r.idempotencyKey !== undefined) headers['Idempotency-Key'] = r.idempotencyKey;
  if (r.method === 'POST') headers['content-type'] = 'application/json';
  return headers;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one request, re-signed for every attempt (a new nonce and timestamp; the same body and Idempotency-Key).
 * Each attempt has `timeoutMs` (default 15 s) for the whole exchange, the answer's body included. Retries a network
 * error or a timeout, 500 and 503 with backoff, and 429 after its retry-after (up to `maxWaitS`); `attempts` (default
 * 4) counts the first one. Every other answer comes back as it is: read `body.code`.
 */
export async function callPlatform(
  cfg: PlatformConfig,
  req: PlatformRequest,
  o: { attempts?: number; maxWaitS?: number; timeoutMs?: number } = {},
): Promise<PlatformAnswer> {
  const attempts = o.attempts ?? 4;
  const maxWaitS = o.maxWaitS ?? 60;
  const timeoutMs = o.timeoutMs ?? 15_000;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('attempts is a whole number, 1 or more');
  if (!Number.isFinite(maxWaitS) || maxWaitS < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('maxWaitS and timeoutMs are positive numbers');
  const apiBase = cfg.apiBase.replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#]+(\/[^?#]*)?$/.test(apiBase)) throw new Error(`Not an API base URL: ${cfg.apiBase}`);
  const body = req.method === 'POST' ? enc.encode(JSON.stringify(req.body ?? {})) : new Uint8Array(0);
  if (req.method === 'POST' && req.idempotencyKey === undefined && req.path !== '/v1/platform/credential/revoke') throw new Error('Every write needs an Idempotency-Key');
  const doFetch = cfg.fetch ?? fetch;
  for (let attempt = 1; ; attempt++) {
    const headers = await signHeaders(cfg, { method: req.method, path: req.path, body, idempotencyKey: req.idempotencyKey, timestampMs: (cfg.now ?? Date.now)() });
    let res: Response;
    let text: string;
    try {
      // The signal ends the attempt on time, the body's read included; a timeout is retried as a network error.
      const signal = AbortSignal.timeout(timeoutMs);
      res = await doFetch(`${apiBase}${req.path}`, { method: req.method, headers, signal, ...(req.method === 'POST' ? { body } : {}) });
      text = await res.text();
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      parsed = { code: 'not_json', error: text.slice(0, 200) };
    }
    const answer: PlatformAnswer = { status: res.status, body: parsed, requestId: res.headers.get('x-request-id') };
    const retryAfter = Number(res.headers.get('retry-after') ?? '');
    const retryable = res.status === 500 || res.status === 503 || (res.status === 429 && retryAfter > 0 && retryAfter <= maxWaitS);
    if (!retryable || attempt >= attempts) return answer;
    await sleep(res.status === 429 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1));
  }
}
