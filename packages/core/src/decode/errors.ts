// The one error the decoders, normalizeTypedData and the policy matcher's decode step throw. `code` is stable and
// safe to show or log (it never carries request bytes); `message` is for humans and may name a field or a type, never
// a value that could be a secret (decoders only ever see public request bytes).

export type DecodeErrorCode =
  | 'malformed' // not valid JSON / XDR / RLP / ABI, or trailing bytes
  | 'too_large' // a size or depth cap was hit
  | 'unsupported' // well-formed, but a type or variant this decoder refuses (EIP-2930/4844/7702 tx, v0 envelope, …)
  | 'invalid_value' // a value out of range or not canonical (non-minimal RLP integer, bad checksum, bad padding)
  | 'network_mismatch' // the bytes name another network or chain than the request context
  | 'typed_data_invalid'; // EIP-712 typed data refused by normalizeTypedData

export class DecodeError extends Error {
  readonly code: DecodeErrorCode;

  constructor(code: DecodeErrorCode, message: string) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
  }
}

/** Throws a DecodeError. */
export function fail(code: DecodeErrorCode, message: string): never {
  throw new DecodeError(code, message);
}
