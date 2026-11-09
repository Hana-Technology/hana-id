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

/** `watchdog.pinnedExitClients` (D468, D493): the exit clients expected on chain, as `[provider, aud]`. Absent: nothing pinned. */
export type ExitPins = [string, string][];

/**
 * The `EXIT_PINS` var (JSON, written by `gen`). Absent → `pins: null` (nothing pinned: every on-chain exit client is
 * unpinned). Malformed → `pins: null` with the problem for the `config` check: a broken var never loosens anything.
 */
export function parseExitPins(raw: string | undefined): { pins: ExitPins | null; problems: string[] } {
  if (raw === undefined || raw.trim() === '') return { pins: null, problems: [] };
  const bad = { pins: null, problems: ['EXIT_PINS is malformed: every exit client is treated as unpinned'] };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad;
  }
  if (!Array.isArray(v) || !v.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')) return bad;
  return { pins: v as ExitPins, problems: [] };
}

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

/**
 * Why an email key (pending or active) isn't the pinned key it claims to be. `pins_unreadable`: `not_pinned` while the
 * manifest's pins couldn't be read (the `config` check pages `pins_invalid`): the key may be fine, the config isn't.
 * `bad_material`: on-chain `n`/`e` that can't be hashed (fail closed: never judged by its kid alone).
 */
export type EmailKeyReason = 'not_pinned' | 'pins_unreadable' | 'bad_material' | 'kid_not_thumbprint' | 'other_signer' | 'no_signer';

export const EMAIL_KEY_WHY: Record<EmailKeyReason, string> = {
  not_pinned: 'its key is not pinned',
  pins_unreadable: "the watchdog's email pins are unreadable (EMAIL_PINS), so no key counts as pinned",
  bad_material: 'its key material cannot be hashed',
  kid_not_thumbprint: 'its kid is not the RFC 7638 thumbprint of its key',
  other_signer: 'its key is pinned for another signer',
  no_signer: 'it names no signer (the email issuer is not self-issued)',
};

export interface EmailKeyVerdict {
  /** null: the pinned key it claims to be. */
  reason: EmailKeyReason | null;
  /** RFC 7638 thumbprint of the key material (null without material, or unhashable material). */
  thumbprint: string | null;
  /** The pinned signers that list it. */
  pinnedFor: string[];
}

/**
 * One email key against the pins: its material's thumbprint must be pinned, its kid must be that thumbprint (Hana's
 * issuer names each key so), and it must be pinned for its signer. `signer` is the change's `signer` for a pending
 * Add (`requireSigner`: a pending Add with none is `no_signer`), or the signer `get_self_issued` lists the active kid
 * under (null: unattributed, e.g. a dropped signer's key, then any pinned signer will do). Only a key with no material
 * at all (a contract without `get_issuer_keys`) is judged by its kid; material that can't be hashed is `bad_material`.
 */
export async function emailKeyVerdict(pins: SignerPins | null, key: { kid: string; n: string | null; e: string | null }, signer: string | null, requireSigner: boolean): Promise<EmailKeyVerdict> {
  const hasMaterial = key.n !== null || key.e !== null;
  const thumbprint = key.n && key.e ? await rsaThumbprint({ n: key.n, e: key.e }) : null;
  if (hasMaterial && thumbprint === null) return { reason: 'bad_material', thumbprint: null, pinnedFor: [] };
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

/** The contract's policy overlap (`POLICY_OVERLAP_MS` in `self_issued.rs`, the email token lifetime). */
export const POLICY_OVERLAP_MS = 600_000;
/** Clock skew and run spacing allowed on top of it before an overlap counts as too long (one run interval). */
export const OVERLAP_SLACK_MS = 300_000;

export interface PolicyFindings {
  /** Every difference between the chain's email issuer and signer policy and the pins. */
  differences: string[];
  /** Differences that make the chain's policy weaker than the pins: critical, and the watchdog pauses. */
  weaker: string[];
  /** Other critical differences (an email issuer nobody pinned, a pre-v3 email issuer): critical, no pause. */
  critical: string[];
  /**
   * Expected while the pins and the chain move through a planned change (L5): a pinned signer not in the policy yet,
   * the gap between `set_issuer` and `mark_self_issued`, a higher `required` on chain, an overlap of normal length.
   * A warning, no pause.
   */
  transition: string[];
}

const describePolicy = (si: SelfIssuedView) => `{signers: [${si.signers.map((s) => ident(s.id)).join(', ')}], required: ${si.required}}`;

/**
 * `get_issuer("email")` and `get_self_issued("email")` against the pins (signers, `required` and the overlap; kids
 * are judged per key). Weaker (D191): a lower `required` than pinned, a signer the pins don't list, active email keys
 * with no signer policy, or an overlap with the previous policy lasting longer than the contract's 10 minutes plus
 * one run (a `migrate` could otherwise keep a weaker previous policy valid indefinitely). `now` is wall-clock ms.
 */
export function policyFindings(pins: SignerPins | null, email: EmailSnapshot, now: number): PolicyFindings {
  const { issuer, selfIssued: si } = email;
  const f: PolicyFindings = { differences: [], weaker: [], critical: [], transition: [] };
  const add = (level: 'weaker' | 'critical' | 'transition', text: string) => {
    f.differences.push(text);
    f[level].push(text);
  };
  if (!issuer && !si) return f;
  if (!pins) {
    add('critical', 'an email issuer is on chain but the watchdog pins no email keys (watchdog.pinnedIssuerKeys.email)');
    if (si) add('critical', `its signer policy ${describePolicy(si)} is not pinned`);
    return f;
  }
  if (!si) {
    const active = email.issuerKeys?.length ?? issuer?.kids.length ?? 0;
    if (active > 0) add('weaker', `${active} active email key(s) with no signer policy`);
    else if (email.hasSelfIssuedView) add('transition', 'the email issuer is not self-issued yet (no signer policy, no key)');
    else add('critical', 'the contract has no get_self_issued (pre-v3): the email issuer has no signer policy');
    return f;
  }
  const chainIds = si.signers.map((s) => s.id);
  const pinIds = Object.keys(pins.signers);
  for (const id of pinIds) if (!chainIds.includes(id)) add('transition', `pinned signer ${ident(id)} is not in the policy`);
  for (const id of chainIds) if (!pinIds.includes(id)) add('weaker', `signer ${ident(id)} is not pinned`);
  if (si.required < pins.required) add('weaker', `required ${si.required} is below the pinned ${pins.required}`);
  else if (si.required > pins.required) add('transition', `required is ${si.required}, pinned ${pins.required}`);
  const until = si.overlap_until_ms;
  if (typeof until === 'number' && until > now) {
    const text = `tokens valid under the previous policy still pass until ${new Date(until).toISOString()}`;
    add(until > now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS ? 'weaker' : 'transition', until > now + POLICY_OVERLAP_MS + OVERLAP_SLACK_MS ? `${text} (longer than the contract's 10-minute overlap)` : text);
  }
  return f;
}

/** A short stable id of the chain's email policy, for the alerts' keys (a new state is a new alert). */
export function policyId(email: EmailSnapshot): string {
  if (email.selfIssued) return `${email.selfIssued.signers.map((s) => s.id).join('+')}/${email.selfIssued.required}${email.selfIssued.overlap_until_ms ? '+overlap' : ''}`;
  return email.issuer ? 'not-self-issued' : 'none';
}
