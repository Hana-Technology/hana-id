// The partner identity token's published keys (docs/identity-token-spec.md "JWKS and discovery", D127 Q13, D210):
// partners verify identity tokens against the API's JWKS, which Hana's Cloudflare account serves, so whoever controls
// that account could publish a key of their own and partners would accept tokens for any user. The watchdog pins the
// keys' RFC 7638 thumbprints in its own config (`watchdog.pinnedIdentityKeys`, a redeploy on its own account to
// change) and reads the JWKS and the discovery document each run, in the advisory phase (they are Hana's answers, a
// party the watchdog must survive, D86). The chain is not involved: the contract never holds or accepts an identity
// key, so there is nothing to cancel or pause; every finding is an alert. Pure functions here; run.ts raises the alerts.
//
// Absent pins mean nothing is pinned (as D190 for the email issuer): every published identity key is unpinned.

/** RFC 7638 thumbprints are 43 base64url characters (SHA-256). */
const THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/u;
/** A P-256 coordinate: 32 bytes as unpadded base64url. */
const COORD_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
/** At most this many entries are listed in one alert's details (the body is capped at 64 KB, so a few hundred keys). */
export const MAX_LISTED = 20;
/** Stored strings from Hana's answers (kids, issuer, jwks_uri) are cut to this length. */
export const MAX_STORED_CHARS = 256;

/**
 * JWK members that only a private (or symmetric) key has (RFC 7518 §6.2.2, §6.3.2, §6.4.1). Any of them published
 * means a signing key is out: whoever read the JWKS can forge tokens with it.
 */
export const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export interface IdentityPins {
  /** Pinned thumbprints; null: nothing pinned (absent, or unreadable). */
  pins: string[] | null;
  /** Why IDENTITY_PINS couldn't be read (for the `config` check and `pins_invalid`). */
  problems: string[];
}

/**
 * The `IDENTITY_PINS` var (JSON array of thumbprints, written by `gen` from `watchdog.pinnedIdentityKeys`). Absent →
 * nothing pinned. Malformed → also nothing pinned, with the problem: a broken var never loosens anything.
 */
export function parseIdentityPins(raw: string | undefined): IdentityPins {
  if (raw === undefined || raw.trim() === '') return { pins: null, problems: [] };
  const bad: IdentityPins = { pins: null, problems: ['IDENTITY_PINS is malformed: every published identity key is treated as unpinned'] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad;
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > 8 || !v.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t)) || new Set(v).size !== v.length) return bad;
  return { pins: [...(v as string[])], problems: [] };
}

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

export const identityJwksUrl = (iss: string): string => `${iss.replace(/\/+$/u, '')}/jwks.json`;
export const identityDiscoveryUrl = (iss: string): string => `${iss.replace(/\/+$/u, '')}/.well-known/openid-configuration`;

/** Hana's answer isn't the document it should be (not JSON of the expected shape): judged as a failed fetch. */
export class MalformedDocument extends Error {
  constructor(what: string) {
    super(`not a ${what}`);
    this.name = 'MalformedDocument';
  }
}

const cutStored = (s: string): string => (s.length <= MAX_STORED_CHARS ? s : `${s.slice(0, MAX_STORED_CHARS - 3)}...`);

/** Why a published key is not one the watchdog accepts. */
export type UnpinnedReason = 'not_pinned' | 'not_p256' | 'pins_unreadable';

export interface PublishedKey {
  /** The entry's `kid` as published (cut to 256 characters), or null when it has none or not a string. */
  kid: string | null;
  /** Its RFC 7638 thumbprint, or null when it isn't a P-256 public key. */
  thumbprint: string | null;
  /** A stable reference: the thumbprint, else `entry:` + a hash of the entry (for alert keys; attacker text never). */
  ref: string;
  pinned: boolean;
  /** Private members present (`d`, …): a published signing key. */
  private: string[];
  /** Null when pinned. */
  reason: UnpinnedReason | null;
}

export interface MissingPin {
  thumbprint: string;
  /** `not_published`: no entry with its material; `kid_differs`: published, but under another kid. */
  reason: 'not_published' | 'kid_differs';
}

export interface JwksVerdict {
  keys: PublishedKey[];
  /** Keys the watchdog doesn't pin (critical, no pause). */
  unpinned: PublishedKey[];
  /** Keys with private members (critical, pinned or not). */
  privateKeys: PublishedKey[];
  /** Pinned keys not published under their thumbprint as kid (warning). */
  missing: MissingPin[];
}

/**
 * Hana's identity JWKS against the pins. Each entry is judged by its key material, never by its kid: a kid that names
 * a pinned key over other material is unpinned. Throws `MalformedDocument` when the body isn't `{keys: [object…]}`.
 */
export async function judgeIdentityJwks(body: unknown, pins: IdentityPins): Promise<JwksVerdict> {
  const list = (body as { keys?: unknown } | null)?.keys;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !Array.isArray(list) || !list.every((k) => typeof k === 'object' && k !== null && !Array.isArray(k))) {
    throw new MalformedDocument('JWKS');
  }
  const pinned = new Set(pins.pins ?? []);
  const keys: PublishedKey[] = [];
  for (const entry of list as Record<string, unknown>[]) {
    const thumbprint = await p256Thumbprint(entry);
    const kid = typeof entry.kid === 'string' ? cutStored(entry.kid) : null;
    const isPinned = thumbprint !== null && pinned.has(thumbprint);
    const reason: UnpinnedReason | null = isPinned ? null : thumbprint === null ? 'not_p256' : pins.problems.length ? 'pins_unreadable' : 'not_pinned';
    keys.push({
      kid,
      thumbprint,
      ref: thumbprint ?? `entry:${(await sha256b64url(JSON.stringify(entry))).slice(0, 22)}`,
      pinned: isPinned,
      private: PRIVATE_MEMBERS.filter((m) => Object.hasOwn(entry, m)),
      reason,
    });
  }
  const missing: MissingPin[] = [];
  for (const tp of pins.pins ?? []) {
    if (keys.some((k) => k.thumbprint === tp && k.kid === tp)) continue;
    missing.push({ thumbprint: tp, reason: keys.some((k) => k.thumbprint === tp) ? 'kid_differs' : 'not_published' });
  }
  return { keys, unpinned: keys.filter((k) => !k.pinned), privateKeys: keys.filter((k) => k.private.length > 0), missing };
}

export interface DiscoveryProblem {
  field: 'issuer' | 'jwks_uri';
  expected: string;
  /** As published (cut to 256 characters), or null when absent or not a string. */
  published: string | null;
}

export interface DiscoveryVerdict {
  issuer: string | null;
  jwks_uri: string | null;
  problems: DiscoveryProblem[];
}

/**
 * The discovery document against the identity issuer the watchdog was configured with (`identityToken.iss`): its
 * `issuer` must be that `iss` exactly (an OpenID client checks a token's `iss` against it), and its `jwks_uri` the
 * JWKS the watchdog checks (a client that follows discovery fetches keys from there, past the pin check). Throws
 * `MalformedDocument` when the body isn't a JSON object.
 */
export function judgeDiscovery(body: unknown, iss: string): DiscoveryVerdict {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new MalformedDocument('discovery document');
  const d = body as { issuer?: unknown; jwks_uri?: unknown };
  const issuer = typeof d.issuer === 'string' ? d.issuer : null;
  const jwksUri = typeof d.jwks_uri === 'string' ? d.jwks_uri : null;
  const problems: DiscoveryProblem[] = [];
  if (issuer !== iss) problems.push({ field: 'issuer', expected: iss, published: issuer === null ? null : cutStored(issuer) });
  if (jwksUri !== identityJwksUrl(iss)) problems.push({ field: 'jwks_uri', expected: identityJwksUrl(iss), published: jwksUri === null ? null : cutStored(jwksUri) });
  return { issuer: issuer === null ? null : cutStored(issuer), jwks_uri: jwksUri === null ? null : cutStored(jwksUri), problems };
}

/** Where an identity thumbprint shows up on chain (`identity_key_on_chain`). */
export interface OnChainHit {
  where: 'active' | 'pending';
  provider: string;
  kid: string;
  /** The pending change's id (pending only). */
  change?: number;
}

/**
 * Issuer keys on chain whose kid is an identity key's thumbprint (spec "JWKS and discovery": "the contract must never
 * trust it"). The contract holds RSA keys only (`RsaKey {n, e}`), so an identity key's EC material can never be on
 * chain; its kid can, and that is the sign checked here: someone posting an identity key's kid as an issuer key.
 */
export function identityKeysOnChain(
  chain: { issuerKids: string[]; emailKids: string[]; pending: { id: number; provider: string; kid: string; op: string }[] },
  thumbprints: ReadonlySet<string>,
): OnChainHit[] {
  const hits: OnChainHit[] = [];
  for (const kid of chain.issuerKids) if (thumbprints.has(kid)) hits.push({ where: 'active', provider: 'google', kid });
  for (const kid of chain.emailKids) if (thumbprints.has(kid)) hits.push({ where: 'active', provider: 'email', kid });
  for (const c of chain.pending) if (c.op === 'Add' && thumbprints.has(c.kid)) hits.push({ where: 'pending', provider: c.provider, kid: c.kid, change: c.id });
  return hits;
}
