// The platform API's request format (D927; docs/partner-platform-spec.md A3 "The request", A5, A8): how a network's
// backend signs each request to `{API}/v1/platform/…` with its platform key (D918), what the API checks before it
// verifies a signature, and the reference signer the network's guide ships (P8). The API's verifier
// (apps/api/src/platform/request.ts) builds the same message from the one parsed URL; the vectors in
// test/platform-request-vectors.json come from an independent implementation (scripts/gen-platform-request-vectors.mjs:
// node:crypto and its own ECDSA in BigInt arithmetic), which this module must agree with byte for byte.
//
// The signed message is these lines joined by "\n" (0x0A), UTF-8, no trailing newline:
//
//   journear-platform-v1
//   <ENV_NAME>            the env's name (another env's request never verifies here)
//   <SIGNER_ACCOUNT>      the env's contract account
//   <METHOD>              GET or POST
//   <path><query>         exactly as sent: /v1/platform/… and, for a GET, "?a=b&c=d" or nothing
//   <Journear-Key-Id>
//   <Journear-Timestamp>
//   <Journear-Nonce>
//   <Idempotency-Key>     or an empty line
//   <body sha256>         lowercase hex of the exact body bytes (of the empty string for a GET)
//
// The signature is plain ES256 over those bytes (ECDSA P-256, SHA-256, the signer hashing the message once), sent as
// the raw 64 bytes r ‖ s in base64url without padding. Both S values are accepted; a DER signature is refused.
import { z } from '@hana-id/env/zod';
import { b64url, fromB64url, hex, randomBytes, sha256, utf8 } from './bytes.ts';
import { PLATFORM_KEY_ID_RE } from './platform-keys.ts';

/** The message's first line: the format's name and version. */
export const PLATFORM_REQUEST_VERSION = 'journear-platform-v1';

/** The request headers, as a client sends them (HTTP header names are case-insensitive). */
export const PLATFORM_HEADERS = {
  keyId: 'Journear-Key-Id',
  timestamp: 'Journear-Timestamp',
  nonce: 'Journear-Nonce',
  signature: 'Journear-Signature',
  idempotencyKey: 'Idempotency-Key',
} as const;

/** Each header's whole value (A3): matched in full, so nothing is ever trimmed or normalised. */
export const PLATFORM_HEADER_RES = {
  keyId: PLATFORM_KEY_ID_RE,
  /** Unix milliseconds, 13 digits (2001 to 2286). */
  timestamp: /^[1-9][0-9]{12}$/u,
  /** 16 random bytes, base64url without padding (the last character carries 2 bits and 4 zero bits). */
  nonce: /^[A-Za-z0-9_-]{21}[AQgw]$/u,
  /** 64 bytes r ‖ s, base64url without padding (the last character carries 2 bits and 4 zero bits). */
  signature: /^[A-Za-z0-9_-]{85}[AQgw]$/u,
  idempotencyKey: /^[A-Za-z0-9_-]{8,64}$/u,
} as const;

/** The one path form (A3, L1): no empty, `.` or `..` segment, no percent-encoding, no trailing slash. */
export const PLATFORM_PATH_RE = /^\/v1\/platform(\/[A-Za-z0-9_-]+)+$/u;
/** A GET's query, when present: one to four `name=value` pairs of these characters (writes take none). */
export const PLATFORM_QUERY_RE = /^\?[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}(&[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}){0,3}$/u;
/** `content-type` of a POST: `application/json`, optionally with `; charset=utf-8` (compared without case). */
export const PLATFORM_CONTENT_TYPE_RE = /^application\/json(; charset=utf-8)?$/iu;

/** A POST's body: at most 16 KiB of UTF-8 JSON (an object; `{}` when there is nothing to send). */
export const PLATFORM_BODY_MAX = 16 * 1024;
/** The clock window: the request's timestamp within ±60 s of the API's clock. */
export const PLATFORM_CLOCK_SKEW_MS = 60_000;
/** A nonce is held until its request's timestamp + 120 s (after which the timestamp is refused anyway). */
export const PLATFORM_NONCE_HOLD_MS = 120_000;
/**
 * Every header of one request together, names and values (Cloudflare's own `cf-*` headers included), before any
 * signature work. Generous: a signed request needs about 400 bytes of its own.
 */
export const PLATFORM_HEADERS_MAX = 16 * 1024;

/**
 * The platform's limits (A5, provisional, kept low while a network has few partners; D927). Per credential: requests
 * admitted. Per IP: requests not admitted (failures, and refusals after a valid signature). The org's own hot-DB bucket
 * sits under the console's global one (statements; the kill switches may use its reserve); the destructive-call breaker
 * is the platform's own, separate from the console's (M3).
 */
export const PLATFORM_REQUEST_LIMITS = {
  perKeyPerMinute: 60,
  perKeyPerDay: 2000,
  failuresPerIpPerMinute: 30,
  /** Requests from an IP whose failure window is full, across every IP: checked anyway so a valid key still gets in (M2). */
  overflowPerMinute: 120,
  /** Fresh nonces one key may hold a minute (the nonce object's size bound: 5 times the per-key rate). */
  noncesPerKeyPerMinute: 300,
  /** Failed signatures for one known key id in a minute that raise a `platform_auth_failures` event. */
  authFailuresAlert: 10,
  breaker: { perOrgPerHour: 10, globalPerHour: 30 },
} as const;

/** The error codes the platform API answers (stable; `docs/api.md` "Platform API"), with their HTTP status. */
export const PLATFORM_ERROR_STATUS = {
  bad_request: 400,
  stale_request: 400,
  unauthenticated: 401,
  browser_refused: 403,
  platform_off: 403,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  request_replayed: 409,
  conflict: 409,
  version_conflict: 409,
  rate_limited: 429,
  internal: 500,
  rate_limiter_unavailable: 503,
} as const;
export type PlatformErrorCode = keyof typeof PLATFORM_ERROR_STATUS;

/** `POST /v1/platform/credential/revoke`'s body: an optional reason, one line of at most 200 characters. */
export const platformRevokeBody = z
  .object({
    reason: z
      .string()
      .trim()
      .max(200)
      .refine((s) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s), 'One line of plain text')
      .optional(),
  })
  .strict();

/** `GET /v1/platform/credential`: the key's own state. */
export interface PlatformCredentialView {
  keyId: string;
  label: string;
  orgId: string;
  scopes: string[];
  /** RFC 7638 thumbprint of the public key (the fingerprint the screens and emails show). */
  thumbprint: string;
  activeFrom: number;
  expiresAt: number;
  limits: {
    requestsPerMinute: number;
    requestsPerDay: number;
    maxApps: number;
    appCreationsPerDay: number;
    originProposalsPerDay: number;
  };
}

/** What the signed message is built from. `path` is the path and query exactly as sent (`/v1/platform/…?…`). */
export interface PlatformMessageInput {
  envName: string;
  signerAccount: string;
  method: string;
  path: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  idempotencyKey?: string | undefined;
  bodySha256Hex: string;
}

/** The canonical message's text (the bytes signed are its UTF-8). Refuses a part that would make it ambiguous. */
export function platformRequestMessage(i: PlatformMessageInput): string {
  const parts = [PLATFORM_REQUEST_VERSION, i.envName, i.signerAccount, i.method, i.path, i.keyId, i.timestamp, i.nonce, i.idempotencyKey ?? '', i.bodySha256Hex];
  if (parts.some((p) => p.includes('\n') || p.includes('\r'))) throw new TypeError('A part of the signed message holds a line break');
  if (!i.envName || !i.signerAccount) throw new TypeError('The signed message names the env and its signer account');
  if (!/^[0-9a-f]{64}$/u.test(i.bodySha256Hex)) throw new TypeError('The body hash is 64 lowercase hex characters');
  return parts.join('\n');
}

/** Lowercase hex sha256 of the body's exact bytes (the empty string for a GET). */
export async function bodySha256Hex(body: Uint8Array): Promise<string> {
  return hex(await sha256(body));
}

/** P-256's group order n. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const big = (bytes: Uint8Array): bigint => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
const bytes32 = (v: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

/**
 * A KMS's DER signature (`SEQUENCE { INTEGER r, INTEGER s }`) as the raw 64 bytes r ‖ s the API wants: each integer's
 * leading 0x00 dropped, then left-padded to 32 bytes. Refuses anything that isn't exactly that structure.
 */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  const fail = (): never => {
    throw new TypeError('Not a DER ECDSA P-256 signature');
  };
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[1]! > 0x7f) fail();
  let at = 2;
  const int = (): Uint8Array => {
    if (der[at] !== 0x02) fail();
    const len = der[at + 1]!;
    if (len < 1 || len > 33 || at + 2 + len > der.length) fail();
    let v = der.subarray(at + 2, at + 2 + len);
    at += 2 + len;
    // DER: no negative value, and no leading zero unless the next byte needs it.
    if (v[0]! & 0x80) fail();
    if (v.length > 1 && v[0] === 0 && !(v[1]! & 0x80)) fail();
    if (v[0] === 0) v = v.subarray(1);
    if (v.length > 32) fail();
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int();
  const s = int();
  if (at !== der.length) fail();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** The same signature with the other S value (n − s): ECDSA's malleability, which the API accepts (A3, M4). */
export function otherSValue(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new TypeError('A raw signature is 64 bytes');
  const s = big(raw.subarray(32));
  const out = new Uint8Array(64);
  out.set(raw.subarray(0, 32), 0);
  out.set(bytes32(N - s), 32);
  return out;
}

/** Whether a raw signature's S is the high one (above n/2). */
export const isHighS = (raw: Uint8Array): boolean => big(raw.subarray(32, 64)) > N / 2n;

export interface PlatformSignInput {
  envName: string;
  signerAccount: string;
  keyId: string;
  method: 'GET' | 'POST';
  /** The path and query as they will be sent: `/v1/platform/…`. */
  path: string;
  /** A POST's exact body bytes (or text); none for a GET. */
  body?: Uint8Array | string | undefined;
  idempotencyKey?: string | undefined;
  /** Defaults: now, and 16 fresh random bytes. */
  timestampMs?: number | undefined;
  nonce?: string | undefined;
}

/**
 * The reference signer (A3; the network's guide, piece P8): the headers for one request, signed with WebCrypto by an
 * ECDSA P-256 private key. A KMS that signs a digest is given sha256(message) instead, and its DER answer converted with
 * `derToRawSignature`. Every request needs a fresh nonce; a retry of a write resends the same Idempotency-Key.
 */
export async function signPlatformRequest(privateKey: Parameters<typeof crypto.subtle.sign>[1], i: PlatformSignInput): Promise<{ headers: Record<string, string>; body: Uint8Array; message: string }> {
  const body = i.body === undefined ? new Uint8Array(0) : typeof i.body === 'string' ? utf8(i.body) : i.body;
  if (i.method === 'GET' && body.length > 0) throw new TypeError('A GET has no body');
  const timestamp = String(i.timestampMs ?? Date.now());
  const nonce = i.nonce ?? b64url(randomBytes(16));
  const message = platformRequestMessage({
    envName: i.envName,
    signerAccount: i.signerAccount,
    method: i.method,
    path: i.path,
    keyId: i.keyId,
    timestamp,
    nonce,
    idempotencyKey: i.idempotencyKey,
    bodySha256Hex: await bodySha256Hex(body),
  });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(message) as Uint8Array<ArrayBuffer>));
  const headers: Record<string, string> = {
    [PLATFORM_HEADERS.keyId]: i.keyId,
    [PLATFORM_HEADERS.timestamp]: timestamp,
    [PLATFORM_HEADERS.nonce]: nonce,
    [PLATFORM_HEADERS.signature]: b64url(sig),
  };
  if (i.idempotencyKey !== undefined) headers[PLATFORM_HEADERS.idempotencyKey] = i.idempotencyKey;
  if (i.method === 'POST') headers['content-type'] = 'application/json';
  return { headers, body, message };
}

/** A raw signature from its header value, or null (the header's rule is checked first). */
export function signatureBytes(header: string): Uint8Array | null {
  if (!PLATFORM_HEADER_RES.signature.test(header)) return null;
  const b = fromB64url(header);
  return b.length === 64 ? b : null;
}
