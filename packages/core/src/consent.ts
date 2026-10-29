// The auto-approve consent digest (docs/batch-b-spec.md "Consent"). The approval popup computes it from the consent
// screen it rendered (the policyId it recomputed from the policy it validated and showed, the parent origin and the
// end time) and returns it with Allow; the vault recomputes it from the consent request it sent and stores a consent
// only on a match, so an Allow binds that exact policy, site and duration.
//
//   digest = sha256(utf8("hana-id/auto-approve-consent/v1") ‖ borsh(id) ‖ borsh(policyId) ‖ borsh(parentOrigin)
//                   ‖ u64le(expiresAtMs))
import { type Bytes, borshString, concatBytes, sha256, u64le, utf8 } from './bytes.ts';

export const CONSENT_DIGEST_DOMAIN = 'hana-id/auto-approve-consent/v1';

export interface ConsentDigestInput {
  /** The consent request id (128-bit random, from the vault). */
  readonly id: string;
  /** 64 lowercase hex (policy/id.ts). */
  readonly policyId: string;
  readonly parentOrigin: string;
  readonly expiresAtMs: number;
}

export function consentDigest(i: ConsentDigestInput): Bytes {
  if (!/^[0-9a-f]{64}$/u.test(i.policyId)) throw new Error('policyId must be 64 lowercase hex');
  if (i.id.length === 0 || i.parentOrigin.length === 0) throw new Error('id and parentOrigin must be non-empty');
  return sha256(concatBytes(utf8(CONSENT_DIGEST_DOMAIN), borshString(i.id), borshString(i.policyId), borshString(i.parentOrigin), u64le(i.expiresAtMs)));
}
