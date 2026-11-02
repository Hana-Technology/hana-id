// The rules that judge Hana's partner identity JWKS and discovery document (docs/identity-token-spec.md "JWKS and
// discovery", D210, D213, D214), shared by the watchdog (apps/watchdog, its own Cloudflare account) and the
// outside probe (scripts/identity-probe.ts, GitHub Actions), so both apply the same rules. No I/O here: callers fetch,
// with `redirect: 'manual'`, a 200 status required and the body capped (`IDENTITY_BODY_LIMIT`).
//
// Every entry is judged by its key material (its RFC 7638 P-256 thumbprint), never by its kid; an entry is accepted
// only when its thumbprint is pinned and it has no member beyond the public ones (`PUBLIC_MEMBERS`).

/** The byte cap on either document (a few keys are ~1 KB). Over it is a finding, not a fetch failure. */
export const IDENTITY_BODY_LIMIT = 64 * 1024;

/** The members a published identity key may have. Anything else makes the entry unpinned (D214). */
export const PUBLIC_MEMBERS = ['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg'] as const;

/**
 * JWK members that only a private (or symmetric) key has (RFC 7518 §6.2.2, §6.3.2, §6.4.1). Any of them published
 * means a signing key is out: whoever read the JWKS can forge tokens with it.
 */
export const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

/** At most this many entries are listed in one finding (the body is capped, so a few hundred keys). */
export const MAX_LISTED = 20;
/** Strings from Hana's answers (kids, issuer, jwks_uri, paths) are cut to this length when kept. */
export const MAX_STORED_CHARS = 256;

/** A P-256 coordinate: 32 bytes as unpadded base64url. */
const COORD_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

export const identityJwksUrl = (iss: string): string => `${iss.replace(/\/+$/u, '')}/jwks.json`;
export const identityDiscoveryUrl = (iss: string): string => `${iss.replace(/\/+$/u, '')}/.well-known/openid-configuration`;

export const cutStored = (s: string): string => (s.length <= MAX_STORED_CHARS ? s : `${s.slice(0, MAX_STORED_CHARS - 3)}...`);

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export async function sha256b64url(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/**
 * RFC 7638 thumbprint of a P-256 public JWK: base64url(SHA-256(`{"crv":"P-256","kty":"EC","x":…,"y":…}`)), the kid
 * Hana gives each identity key (`@hana-id/core` `jwkThumbprint`, `@hana-id/env` `p256Thumbprint`). Null for anything
 * that isn't an EC P-256 key with 32-byte base64url coordinates (fail closed: such a key is never pinned).
 */
export async function p256Thumbprint(key: unknown): Promise<string | null> {
  if (typeof key !== 'object' || key === null) return null;
  const k = key as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown };
  if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.x !== 'string' || typeof k.y !== 'string' || !COORD_RE.test(k.x) || !COORD_RE.test(k.y)) return null;
  return sha256b64url(`{"crv":"P-256","kty":"EC","x":"${k.x}","y":"${k.y}"}`);
}

/**
 * Every member name that appears twice in one object of a JSON text, as a path (`keys[1].x`). `JSON.parse` keeps the
 * last one silently and other parsers keep the first, so a partner's verifier and the watchdog could read different
 * keys from the same document (D214). Escapes are decoded (`"d"` is `d`). `text` must be valid JSON.
 */
export function duplicateMembers(text: string): string[] {
  type Frame = { obj: boolean; path: string; keys: Set<string>; keyNext: boolean; lastKey: string; index: number };
  const stack: Frame[] = [];
  const found: string[] = [];
  const childPath = (f: Frame | undefined): string => (!f ? '' : f.obj ? (f.path ? `${f.path}.${f.lastKey}` : f.lastKey) : `${f.path}[${f.index}]`);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.obj && top.keyNext) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) found.push(top.path ? `${top.path}.${key}` : key);
        top.keys.add(key);
        top.keyNext = false;
        top.lastKey = key;
      }
      i = j;
    } else if (c === '{' || c === '[') {
      stack.push({ obj: c === '{', path: childPath(stack[stack.length - 1]), keys: new Set(), keyNext: c === '{', lastKey: '', index: 0 });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack[stack.length - 1];
      if (top?.obj) top.keyNext = true;
      else if (top) top.index++;
    }
  }
  return found.map(cutStored);
}

/** A document's text, parsed: the value and its duplicate members, or null when it isn't JSON. */
export function parseIdentityDocument(text: string): { value: unknown; duplicates: string[] } | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return { value, duplicates: duplicateMembers(text) };
}

/** Pinned thumbprints (null: nothing pinned), and whether the pins themselves were unreadable. */
export interface IdentityPinSet {
  pins: string[] | null;
  problems: string[];
}

/** Why a published key isn't one the watchdog accepts. */
export type UnpinnedReason = 'not_pinned' | 'not_p256' | 'extra_members' | 'pins_unreadable';

export interface PublishedKey {
  /** Its position in `keys`. */
  index: number;
  /** The entry's `kid` as published (cut), or null when it has none or not a string. */
  kid: string | null;
  /** Its RFC 7638 thumbprint, or null when it isn't a P-256 public key. */
  thumbprint: string | null;
  /** A stable reference: the thumbprint, else `entry:` + a hash of the entry (for alert keys; attacker text never). */
  ref: string;
  /** Pinned thumbprint and public members only. */
  pinned: boolean;
  /** Private members present (`d`, …): a published signing key. */
  private: string[];
  /** Members beyond `PUBLIC_MEMBERS` (the private ones included), cut and at most 20. */
  extra: string[];
  /** Null when pinned. */
  reason: UnpinnedReason | null;
}

export interface MissingPin {
  thumbprint: string;
  /** `not_published`: no entry with its material; `kid_differs`: there under another kid; `not_clean`: under its kid but with other members. */
  reason: 'not_published' | 'kid_differs' | 'not_clean';
}

export interface JwksVerdict {
  /** False when the body isn't `{keys: […]}`: nothing could be judged. */
  shapeOk: boolean;
  /** What is wrong with the document's shape (`keys[2] is not an object`, …); judged entries are still judged. */
  shapeProblems: string[];
  keys: PublishedKey[];
  unpinned: PublishedKey[];
  privateKeys: PublishedKey[];
  missing: MissingPin[];
}

/**
 * Hana's identity JWKS against the pins. Every object entry is judged, whatever the others are; non-object entries and
 * a body that isn't `{keys: […]}` are shape problems (the caller treats them as critical, D210).
 */
export async function judgeIdentityJwks(body: unknown, pins: IdentityPinSet): Promise<JwksVerdict> {
  const empty = (problem: string): JwksVerdict => ({ shapeOk: false, shapeProblems: [problem], keys: [], unpinned: [], privateKeys: [], missing: [] });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return empty('the JWKS is not a JSON object');
  const list = (body as { keys?: unknown }).keys;
  if (!Array.isArray(list)) return empty('`keys` is not an array');
  const pinned = new Set(pins.pins ?? []);
  const shapeProblems: string[] = [];
  const keys: PublishedKey[] = [];
  for (const [index, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      shapeProblems.push(`keys[${index}] is not an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const thumbprint = await p256Thumbprint(e);
    const members = Object.keys(e);
    const extra = members.filter((m) => !(PUBLIC_MEMBERS as readonly string[]).includes(m));
    const isPinned = thumbprint !== null && pinned.has(thumbprint) && extra.length === 0;
    const reason: UnpinnedReason | null = isPinned
      ? null
      : thumbprint === null
        ? 'not_p256'
        : extra.length
          ? 'extra_members'
          : pins.problems.length
            ? 'pins_unreadable'
            : 'not_pinned';
    keys.push({
      index,
      kid: typeof e.kid === 'string' ? cutStored(e.kid) : null,
      thumbprint,
      ref: thumbprint && !extra.length ? thumbprint : `entry:${(await sha256b64url(JSON.stringify(e))).slice(0, 22)}`,
      pinned: isPinned,
      private: PRIVATE_MEMBERS.filter((m) => Object.hasOwn(e, m)),
      extra: extra.slice(0, MAX_LISTED).map(cutStored),
      reason,
    });
  }
  const missing: MissingPin[] = [];
  for (const tp of pins.pins ?? []) {
    if (keys.some((k) => k.pinned && k.thumbprint === tp && k.kid === tp)) continue;
    const reason = keys.some((k) => k.thumbprint === tp && k.kid === tp) ? 'not_clean' : keys.some((k) => k.thumbprint === tp) ? 'kid_differs' : 'not_published';
    missing.push({ thumbprint: tp, reason });
  }
  return { shapeOk: true, shapeProblems, keys, unpinned: keys.filter((k) => !k.pinned), privateKeys: keys.filter((k) => k.private.length > 0), missing };
}

export interface DiscoveryProblem {
  field: 'issuer' | 'jwks_uri';
  expected: string;
  /** As published (cut), or null when absent or not a string. */
  published: string | null;
}

export interface DiscoveryVerdict {
  /** False when the body isn't a JSON object. */
  shapeOk: boolean;
  issuer: string | null;
  jwks_uri: string | null;
  problems: DiscoveryProblem[];
}

/**
 * The discovery document against the configured issuer (D213): `issuer` must be `iss` exactly (an OpenID client checks
 * a token's `iss` against it byte for byte), and `jwks_uri` must be `{iss}/jwks.json` (a client that follows discovery
 * fetches keys from there, past the pin check). Nothing it advertises is fetched.
 */
export function judgeDiscovery(body: unknown, iss: string): DiscoveryVerdict {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { shapeOk: false, issuer: null, jwks_uri: null, problems: [] };
  const d = body as { issuer?: unknown; jwks_uri?: unknown };
  const issuer = typeof d.issuer === 'string' ? cutStored(d.issuer) : null;
  const jwksUri = typeof d.jwks_uri === 'string' ? cutStored(d.jwks_uri) : null;
  const problems: DiscoveryProblem[] = [];
  if (d.issuer !== iss) problems.push({ field: 'issuer', expected: iss, published: issuer });
  if (d.jwks_uri !== identityJwksUrl(iss)) problems.push({ field: 'jwks_uri', expected: identityJwksUrl(iss), published: jwksUri });
  return { shapeOk: true, issuer, jwks_uri: jwksUri, problems };
}

/**
 * What a fetch of one identity document gave, for the shared judgement: a 200 body (text), a redirect (never
 * followed: `redirect: 'manual'`), or a body over the cap. Network errors and other HTTP statuses are the caller's
 * (they throw): only those count toward a sustained failure; each of these three is a finding at once (D210).
 */
export type IdentityResponse = { kind: 'body'; text: string } | { kind: 'redirect'; status: number; location: string | null } | { kind: 'too_large' };

/** Why an answer can't be judged as it should: critical at once (D210), except `sustained` (3 failed fetches in a row). */
export type UnreadableReason = 'redirect' | 'too_large' | 'not_json' | 'duplicate_members' | 'bad_shape' | 'sustained';

export interface DocumentFinding {
  reason: UnreadableReason;
  detail: string;
}

/**
 * One answer, parsed and checked for what makes it unreadable: a redirect, a body over the cap, not JSON, duplicate
 * members. Returns the parsed value (null when there is none to judge) and the findings so far; the shape is judged by
 * `judgeIdentityJwks` / `judgeDiscovery`.
 */
export function readIdentityResponse(r: IdentityResponse): { value: unknown; parsed: boolean; findings: DocumentFinding[] } {
  if (r.kind === 'redirect') return { value: null, parsed: false, findings: [{ reason: 'redirect', detail: `HTTP ${r.status} to ${r.location === null ? 'nowhere' : cutStored(r.location)}` }] };
  if (r.kind === 'too_large') return { value: null, parsed: false, findings: [{ reason: 'too_large', detail: `body over ${IDENTITY_BODY_LIMIT} bytes` }] };
  const p = parseIdentityDocument(r.text);
  if (!p) return { value: null, parsed: false, findings: [{ reason: 'not_json', detail: 'the body is not JSON' }] };
  const findings: DocumentFinding[] = p.duplicates.length
    ? [{ reason: 'duplicate_members', detail: `duplicate members: ${p.duplicates.slice(0, MAX_LISTED).join(', ')}` }]
    : [];
  return { value: p.value, parsed: true, findings };
}
