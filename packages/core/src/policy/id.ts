// policyId = sha256(utf8("hana-id/auto-approve/v1") ‖ canonical JSON of the policy), hex. A user's consent is bound to
// it, so any change to the policy (by the owner, by Hana or by a compromised dashboard) needs a new consent. It is
// computed over the normalized policy, so key order, address case and a defaulted `addressArgs` don't change it.
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { type PolicyValidationOptions, canonicalJson, validateAutoApprovePolicy } from './validate.ts';

export const POLICY_ID_DOMAIN = 'hana-id/auto-approve/v1';

/** The policy's id (64 lowercase hex). Throws if the policy doesn't validate. */
export function policyId(policy: unknown, options: PolicyValidationOptions = {}): string {
  const result = validateAutoApprovePolicy(policy, options);
  if (!result.ok) throw new Error(`Invalid auto-approve policy: ${result.problems.join('; ')}`);
  const utf8 = (s: string) => new TextEncoder().encode(s);
  const domain = utf8(POLICY_ID_DOMAIN);
  const body = utf8(canonicalJson(result.policy));
  const preimage = new Uint8Array(domain.length + body.length);
  preimage.set(domain);
  preimage.set(body, domain.length);
  return bytesToHex(sha256(preimage));
}
