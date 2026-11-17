// The error every evm-sponsor signer and builder throws for input it refuses. `code` is stable and safe to show or log;
// `message` is a fixed sentence per check: it never carries a key, a signature, a digest or any input value, so a
// refusal reads the same whatever was passed. The strict subject decoder (subject.ts) throws DecodeError instead, as
// every other decoder does.

export type EvmSponsorErrorCode =
  /** chainId 0, or a chain that is not a positive safe integer. */
  | 'chain_id_invalid'
  /** A chain the caller did not pass in as enabled, or one with no pinned delegate. */
  | 'chain_not_enabled'
  /** A delegation (or an Execute domain) naming anything but the pinned delegate for that chain. */
  | 'delegate_not_pinned'
  /** A malformed or out-of-range field (address, integer, bytes, call count, data size). */
  | 'invalid_input'
  /** A malformed, high-s or otherwise non-canonical signature. */
  | 'invalid_signature'
  /** The Execute's account is not the signing key's address. */
  | 'not_own_account'
  /** A call carries value (sponsored calls are value 0). */
  | 'value_not_allowed';

export class EvmSponsorError extends Error {
  readonly code: EvmSponsorErrorCode;

  constructor(code: EvmSponsorErrorCode, message: string) {
    super(message);
    this.name = 'EvmSponsorError';
    this.code = code;
  }
}

/** Throws an EvmSponsorError. */
export function refuse(code: EvmSponsorErrorCode, message: string): never {
  throw new EvmSponsorError(code, message);
}
