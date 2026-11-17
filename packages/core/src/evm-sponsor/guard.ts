// The generic signing paths must never produce a delegate signature (docs/decisions.md D833): an Execute signed through
// eth_signTypedData_v4 would let any page that can ask for typed data run calls as the user's account, outside the
// sponsored approval and its checks. isSponsorDomain is the test the vault applies (WP3) to refuse such typed data.
// It matches on the domain's `name` alone, any version, any chain, any verifyingContract or salt: the contract hashes
// its name as a constant, so a request with the name is either an Execute for a delegate or something pretending to be
// one, and both are refused on the generic path. A different name cannot make a signature the delegate accepts.
import type { NormalizedTypedData } from '../typed-data.ts';
import { SPONSOR_DELEGATES, SPONSOR_DELEGATE_DOMAIN } from './delegates.ts';

const NAMES: ReadonlySet<string> = new Set([SPONSOR_DELEGATE_DOMAIN.name, ...Object.values(SPONSOR_DELEGATES).map((d) => d.domain.name)]);

/** True when typed data's domain `name` is a pinned delegate's (any version): refuse it on eth_signTypedData_v4. */
export function isSponsorDomain(typedData: NormalizedTypedData): boolean {
  const name = typedData?.domain?.name;
  return typeof name === 'string' && NAMES.has(name);
}
