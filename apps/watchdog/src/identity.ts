// The partner identity token's published keys (docs/identity-token-spec.md "JWKS and discovery", D127 Q13, D210):
// partners verify identity tokens against the API's JWKS, which Hana's Cloudflare account serves, so whoever controls
// that account could publish a key of their own and partners would accept tokens for any user. The watchdog pins the
// keys' RFC 7638 thumbprints in its own config (`watchdog.pinnedIdentityKeys`, a redeploy on its own account to
// change) and reads the JWKS and the discovery document each run, in the advisory phase (they are Hana's answers, a
// party the watchdog must survive, D86). The chain is not involved: the contract never holds or accepts an identity
// key, so there is nothing to cancel or pause; every finding is an alert.
//
// What this catches: an attacker who publishes the same answer to everyone. One who controls Hana's Cloudflare account
// can tell the watchdog's fetch apart (it comes from Cloudflare's network) and serve it a clean JWKS, or publish a key
// between two runs: the outside probe (scripts/identity-probe.ts) narrows the first, partner-side pinning closes both.
//
// The judging rules are in `@hana-id/jwks/identity`, shared with the outside probe. Absent pins mean nothing is pinned
// (as D190 for the email issuer): every published identity key is unpinned.
import type { IdentityPinSet } from '@hana-id/jwks/identity';

export {
  cutStored,
  type DocumentFinding,
  identityDiscoveryUrl,
  identityJwksUrl,
  type IdentityResponse,
  judgeDiscovery,
  judgeIdentityJwks,
  MAX_LISTED,
  p256Thumbprint,
  PRIVATE_MEMBERS,
  type PublishedKey,
  readIdentityResponse,
  sha256b64url,
  type UnreadableReason,
} from '@hana-id/jwks/identity';

/** RFC 7638 thumbprints are 43 base64url characters (SHA-256). */
const THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/u;

export type IdentityPins = IdentityPinSet;

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
