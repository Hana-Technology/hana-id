// The email issuer's pinned keys and signer policy (docs/email-login-spec.md "Watchdog"): the manifest's
// `watchdog.pinnedIssuerKeys.email`, set on the watchdog's own account, so a pin change is a watchdog redeploy by the
// operator, outside Hana's main account. Email keys are self-issued: no outside JWKS vouches for them, so the pins are
// the only truth the watchdog has. Pure functions here; run.ts acts on their verdicts.
//
// Absent pins mean nothing is pinned (D190): every email key is unpinned (a pending one is cancelled, an active one
// pauses), and an email issuer or signer policy on chain is a critical difference. A pre-v3 contract (no
// get_self_issued, no email issuer) reads as "no email issuer": no alert, pins or not.
import { rsaThumbprint } from '@hana-id/jwks';
import type { EmailSnapshot, SelfIssuedView } from './chain.ts';
import { ident } from './sanitize.ts';

/** The path provider of Hana's email issuer (frozen at the address freeze; `SELF_ISSUABLE` in the contract). */
export const EMAIL_PROVIDER = 'email';

/** `watchdog.pinnedIssuerKeys.email` without `jwksUrl`: signer id → pinned thumbprints, and `required`. */
export interface SignerPins {
  required: number;
  signers: Record<string, string[]>;
}

const THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/u;
const SIGNER_RE = /^[a-z0-9_-]{1,32}$/u;

/**
 * The `EMAIL_PINS` var (JSON, written by `gen` from the manifest). Absent → `pins: null` (nothing pinned). Malformed →
 * also `pins: null`, with the problem for the `config` check: a broken var never loosens anything.
 */
export function parsePins(raw: string | undefined): { pins: SignerPins | null; problems: string[] } {
  if (raw === undefined || raw.trim() === '') return { pins: null, problems: [] };
  const bad = { pins: null, problems: ['EMAIL_PINS is malformed: every email key is treated as unpinned'] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad;
  }
  const p = v as SignerPins;
  if (typeof v !== 'object' || v === null || !Number.isInteger(p.required) || typeof p.signers !== 'object' || p.signers === null || Array.isArray(p.signers)) return bad;
  const ids = Object.keys(p.signers);
  if (ids.length < 1 || ids.length > 3 || p.required < 1 || p.required > ids.length) return bad;
  for (const id of ids) {
    const list = p.signers[id];
    if (!SIGNER_RE.test(id) || !Array.isArray(list) || list.length === 0 || !list.every((t) => typeof t === 'string' && THUMBPRINT_RE.test(t))) return bad;
  }
  const all = Object.values(p.signers).flat();
  if (new Set(all).size !== all.length) return bad;
  return { pins: { required: p.required, signers: Object.fromEntries(ids.map((id) => [id, [...p.signers[id]!]])) }, problems: [] };
}

/** The pinned signers listing this thumbprint (at most one: the manifest pins a key once). */
export function pinnedSignersOf(pins: SignerPins | null, thumbprint: string | null): string[] {
  if (!pins || !thumbprint) return [];
  return Object.entries(pins.signers)
    .filter(([, list]) => list.includes(thumbprint))
    .map(([id]) => id);
}

/** Why an email key (pending or active) isn't the pinned key it claims to be. */
export type EmailKeyReason = 'not_pinned' | 'kid_not_thumbprint' | 'other_signer' | 'no_signer';

export const EMAIL_KEY_WHY: Record<EmailKeyReason, string> = {
  not_pinned: 'its key is not pinned',
  kid_not_thumbprint: 'its kid is not the RFC 7638 thumbprint of its key',
  other_signer: 'its key is pinned for another signer',
  no_signer: 'it names no signer (the email issuer is not self-issued)',
};

export interface EmailKeyVerdict {
  /** null: the pinned key it claims to be. */
  reason: EmailKeyReason | null;
  /** RFC 7638 thumbprint of the key material (null without material). */
  thumbprint: string | null;
  /** The pinned signers that list it. */
  pinnedFor: string[];
}

/**
 * One email key against the pins: its material's thumbprint must be pinned, its kid must be that thumbprint (Hana's
 * issuer names each key so), and it must be pinned for its signer. `signer` is the change's `signer` for a pending
 * Add (`requireSigner`: a pending Add with none is `no_signer`), or the signer `get_self_issued` lists the active kid
 * under (null: unattributed, e.g. a dropped signer's key, then any pinned signer will do). Without material (a
 * contract without `get_issuer_keys`) only the kid is judged.
 */
export async function emailKeyVerdict(pins: SignerPins | null, key: { kid: string; n: string | null; e: string | null }, signer: string | null, requireSigner: boolean): Promise<EmailKeyVerdict> {
  const thumbprint = key.n && key.e ? await rsaThumbprint({ n: key.n, e: key.e }) : null;
  const pinnedFor = pinnedSignersOf(pins, thumbprint ?? key.kid);
  let reason: EmailKeyReason | null = null;
  if (pinnedFor.length === 0) reason = 'not_pinned';
  else if (thumbprint !== null && key.kid !== thumbprint) reason = 'kid_not_thumbprint';
  else if (requireSigner && signer === null) reason = 'no_signer';
  else if (signer !== null && !pinnedFor.includes(signer)) reason = 'other_signer';
  return { reason, thumbprint, pinnedFor };
}

/** The signer `get_self_issued` lists an active kid under, or null. */
export function signerOfKid(si: SelfIssuedView | null, kid: string): string | null {
  return si?.signers.find((s) => s.kids.includes(kid))?.id ?? null;
}

export interface PolicyFindings {
  /** Every difference between the chain's email issuer and signer policy and the pins (critical). */
  differences: string[];
  /** The ones that make the chain's policy weaker than the pins (pause). */
  weaker: string[];
}

const describePolicy = (si: SelfIssuedView) => `{signers: [${si.signers.map((s) => ident(s.id)).join(', ')}], required: ${si.required}}`;

/**
 * `get_issuer("email")` and `get_self_issued("email")` against the pins (signers and `required`; kids are judged per
 * key). Weaker (D191): a lower `required` than pinned, a signer the pins don't list, or active email keys with no
 * signer policy at all. A pinned signer the chain doesn't list yet, or a higher `required`, is a difference only: the
 * operator pins a new signer before the upgrade that adds it executes, and raises the pinned `required` after.
 */
export function policyFindings(pins: SignerPins | null, email: EmailSnapshot): PolicyFindings {
  const { issuer, selfIssued: si } = email;
  const differences: string[] = [];
  const weaker: string[] = [];
  if (!issuer && !si) return { differences, weaker };
  if (!pins) {
    differences.push('an email issuer is on chain but the watchdog pins no email keys (watchdog.pinnedIssuerKeys.email)');
    if (si) differences.push(`its signer policy ${describePolicy(si)} is not pinned`);
    return { differences, weaker };
  }
  if (!si) {
    differences.push(email.hasSelfIssuedView ? 'the email issuer is not self-issued (no signer policy)' : 'the contract has no get_self_issued (pre-v3): the email issuer has no signer policy');
    const active = email.issuerKeys?.length ?? issuer?.kids.length ?? 0;
    if (active > 0) weaker.push(`${active} active email key(s) with no signer policy`);
    return { differences, weaker };
  }
  const chainIds = si.signers.map((s) => s.id);
  const pinIds = Object.keys(pins.signers);
  for (const id of pinIds) if (!chainIds.includes(id)) differences.push(`pinned signer ${ident(id)} is not in the policy`);
  for (const id of chainIds) {
    if (pinIds.includes(id)) continue;
    differences.push(`signer ${ident(id)} is not pinned`);
    weaker.push(`signer ${ident(id)} is not pinned`);
  }
  if (si.required !== pins.required) {
    differences.push(`required is ${si.required}, pinned ${pins.required}`);
    if (si.required < pins.required) weaker.push(`required ${si.required} is below the pinned ${pins.required}`);
  }
  return { differences, weaker };
}

/** A short stable id of the chain's email policy, for the mismatch alert's key (a new state is a new alert). */
export function policyId(email: EmailSnapshot): string {
  if (email.selfIssued) return `${email.selfIssued.signers.map((s) => s.id).join('+')}/${email.selfIssued.required}`;
  return email.issuer ? 'not-self-issued' : 'none';
}
