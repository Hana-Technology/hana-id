// The approval popup's decode of a sponsored EVM action (kind `evm_sponsored`, D850): the subject bytes the vault
// built (`@hana-id/core/evm-sponsor` encodeSponsorSubject, D846), read strictly by decodeSponsorSubject, and every
// call in it decoded by the same decodeCall as an ordinary EVM transaction's (decode/evm.ts), so the summary and its
// warnings are the same for a call whether or not Journear pays its fee.
//
// The partner page chooses the calls; the vault chooses everything else in the subject (the delegate, the relayer,
// the nonces, the deadline, the gas floor). The popup trusts neither: a request is refused here (no Approve) unless
//   - the subject decodes strictly (one encoding per subject, value 0 on every call, no call to the zero address, the
//     account itself or the delegate, 1 to 8 calls),
//   - it names the request's chain (the approval context) and this build has sponsorship on for that chain
//     (`sponsorChains`, the build's manifest: HanaEnv.evmSponsor),
//   - its delegate is the pinned, reviewed delegate for that chain (SPONSOR_DELEGATES, never a placeholder) and the
//     build's, its relayer is the build's, and its account is the request's address,
//   - every call names a function (at least 4 bytes of calldata: a sponsored call is never a bare transfer, D835).
import { from0xHex } from '../bytes.ts';
import { type EvmSponsorSubject, decodeSponsorSubject } from '../evm-sponsor/subject.ts';
import { sponsorDelegate } from '../evm-sponsor/delegates.ts';
import { fail } from './errors.ts';
import { type DecodedEvmCallSite, decodeCall } from './evm.ts';

/**
 * The chains a build sponsors, by decimal chain ID: the delegate it may authorize and the relayer every batch names
 * (the shape of HanaEnv.evmSponsor, generated from the manifest after its delegate was checked against the pinned
 * table). Absent or empty: no chain is sponsored, and every sponsored request is refused.
 */
export type SponsorChains = Readonly<Record<string, { readonly delegate: string; readonly relayer: string }>>;

export interface DecodedSponsoredAction {
  readonly chainId: number;
  /** The subject as decodeSponsorSubject read it (addresses EIP-55). */
  readonly subject: EvmSponsorSubject;
  /** The pinned delegate's interface version (the details' "account helper v1"). */
  readonly helperVersion: number;
  /** Each call, decoded as an EVM transaction's call is. */
  readonly calls: readonly DecodedEvmCallSite[];
  /** True when this approval also signs the EIP-7702 authorization: the account's one-time setup. */
  readonly setup: boolean;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Decodes a sponsored action's subject for the approval popup. `chainId` is the request's context, `address` the
 * user's EVM address (the vault's), `chains` the build's sponsor chains. Throws DecodeError for anything the popup
 * must not offer to approve (see the module comment).
 */
export function decodeSponsoredAction(bytes: Uint8Array, chainId: number, address: string, chains: SponsorChains | undefined): DecodedSponsoredAction {
  const subject = decodeSponsorSubject(bytes);
  if (subject.chainId !== chainId) fail('network_mismatch', 'The sponsored action is for another chain');
  const built = chains !== undefined && chains !== null && typeof chains === 'object' && Object.hasOwn(chains, String(chainId)) ? chains[String(chainId)] : undefined;
  if (!built || typeof built.delegate !== 'string' || typeof built.relayer !== 'string') fail('unsupported', 'Journear doesn’t pay network fees on this chain in this build');
  const pinned = sponsorDelegate(chainId);
  if (pinned === null || pinned.placeholder) fail('unsupported', 'No reviewed account helper is pinned for this chain');
  if (!same(subject.delegate, pinned.address) || !same(subject.delegate, built.delegate)) fail('invalid_value', 'The sponsored action names an account helper that isn’t the reviewed one for this chain');
  if (!same(subject.relayer, built.relayer)) fail('invalid_value', 'The sponsored action names a relayer that isn’t this build’s');
  if (!same(subject.account, address)) fail('invalid_value', 'The sponsored action is not for this account');
  const calls = subject.calls.map((c, i) => {
    const data = from0xHex(c.data);
    if (data.length < 4) fail('unsupported', `calls[${i}] names no function`);
    return Object.freeze({ to: c.to, value: c.value, data: c.data, ...decodeCall(data) });
  });
  return Object.freeze({ chainId, subject, helperVersion: pinned.abiVersion, calls: Object.freeze(calls), setup: subject.authNonce !== null });
}
