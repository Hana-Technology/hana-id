// The approval subject of a sponsored EVM action (docs/decisions.md D846): the exact bytes the approval popup decodes
// and shows and the vault re-derives before it signs, so there is one reading of what the user approves:
//
//   utf8("hana-id/evm-sponsored/v1") ‖ rlp([
//     chainId, account, delegate,
//     authNonce,                       // [] when no authorization is signed, [nonce] when one is (nonce 0 included)
//     [[to, value, data], …],          // 1 to 8 calls, value always 0
//     executeNonce, deadline, relayer, minGas,
//   ])
//
// Scalars are canonical RLP integers (big-endian, no leading zero, 0 is the empty string), addresses exactly 20 bytes.
// decodeSponsorSubject accepts exactly one encoding of each subject: anything else (a wrong prefix, non-canonical RLP,
// trailing bytes, a wrong field count or kind, a value other than 0, 0 or more than 8 calls, calldata over 8 KiB, a
// zero account, delegate or relayer, a call to the zero address, the account itself or the delegate, a zero deadline
// or minGas, chainId 0) is a DecodeError. encodeSponsorSubject refuses the same
// things, so every subject it makes decodes back to itself.
import { checksumEvmAddress } from '../addresses.ts';
import { type Bytes, concatBytes, toHex, utf8 } from '../bytes.ts';
import { type RlpItem as RlpDecoded, decodeRlp, rlpScalar } from '../decode/rlp.ts';
import { fail } from '../decode/errors.ts';
import { type Hex, bigIntBytes, rlpEncode } from '../signers/evm.ts';
import { AUTHORIZATION_NONCE_MAX, type Authorization } from './authorization.ts';
import { EvmSponsorError } from './errors.ts';
import { EVM_SPONSOR_MAX_CALLS, EVM_SPONSOR_MAX_CALL_DATA_BYTES, type ExecuteCall, type ExecuteInput, isForbiddenSponsorTarget } from './execute.ts';
import { U64_MAX, addressBytes, chainIdOf, dataBytes, snapshotList, uint } from './values.ts';

export const EVM_SPONSOR_SUBJECT_PREFIX = 'hana-id/evm-sponsored/v1';
const PREFIX = utf8(EVM_SPONSOR_SUBJECT_PREFIX);

/** No valid subject is longer (8 calls of 8 KiB data plus generous room for the fixed fields and RLP headers). */
export const EVM_SPONSOR_SUBJECT_MAX_BYTES = PREFIX.length + EVM_SPONSOR_MAX_CALLS * (EVM_SPONSOR_MAX_CALL_DATA_BYTES + 64) + 512;

export interface EvmSponsorSubject {
  readonly chainId: number;
  /** The user's account (EIP-55). */
  readonly account: Hex;
  /** The delegate the account runs or is about to (EIP-55): the authorization's address and the Execute's salt. */
  readonly delegate: Hex;
  /** The authorization's nonce when the action also delegates the account, else null. */
  readonly authNonce: bigint | null;
  /** 1 to 8 calls, each value 0n, `to` EIP-55, `data` lowercase `0x` hex. */
  readonly calls: readonly ExecuteCall[];
  readonly executeNonce: bigint;
  readonly deadline: bigint;
  readonly relayer: Hex;
  readonly minGas: bigint;
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);

/**
 * The subject's bytes. Refuses (DecodeError 'invalid_value') whatever decodeSponsorSubject would refuse. Every field of
 * `s` (and of each call) is read once, into the values that are checked and encoded.
 */
export function encodeSponsorSubject(s: EvmSponsorSubject): Bytes {
  try {
    if (typeof s !== 'object' || s === null) throw new EvmSponsorError('invalid_input', 'subject must be an object');
    const { chainId: rawChainId, account: rawAccount, delegate: rawDelegate, authNonce: rawAuthNonce, calls: rawCalls } = s;
    const { executeNonce: rawNonce, deadline: rawDeadline, relayer: rawRelayer, minGas: rawMinGas } = s;
    const chainId = chainIdOf(rawChainId);
    const account = addressBytes(rawAccount, 'account');
    const delegate = addressBytes(rawDelegate, 'delegate');
    const relayer = addressBytes(rawRelayer, 'relayer');
    if (isZero(account) || isZero(delegate) || isZero(relayer)) fail('invalid_value', 'account, delegate and relayer must not be the zero address');
    const callList = snapshotList(rawCalls, EVM_SPONSOR_MAX_CALLS, 'calls');
    if (callList.length === 0) fail('invalid_value', `calls must hold 1 to ${EVM_SPONSOR_MAX_CALLS} calls`);
    const calls = callList.map((c) => {
      if (typeof c !== 'object' || c === null) fail('invalid_value', 'A call must be an object');
      const { to: rawTo, value, data } = c as ExecuteCall;
      if (value !== 0n) fail('invalid_value', 'A sponsored call carries no value');
      const to = addressBytes(rawTo, 'call.to');
      if (isForbiddenSponsorTarget(to, account, delegate)) fail('invalid_value', 'A sponsored call cannot target the zero address, the account itself or the delegate');
      return [to, new Uint8Array(0), dataBytes(data, EVM_SPONSOR_MAX_CALL_DATA_BYTES, 'call.data')];
    });
    const authNonce = rawAuthNonce === null ? [] : [bigIntBytes(uint(rawAuthNonce, AUTHORIZATION_NONCE_MAX, 'authNonce'))];
    const deadline = uint(rawDeadline, U64_MAX, 'deadline');
    const minGas = uint(rawMinGas, U64_MAX, 'minGas');
    if (deadline === 0n || minGas === 0n) fail('invalid_value', 'deadline and minGas must be positive');
    return concatBytes(
      PREFIX,
      rlpEncode([
        bigIntBytes(BigInt(chainId)),
        account,
        delegate,
        authNonce,
        calls,
        bigIntBytes(uint(rawNonce, U64_MAX, 'executeNonce')),
        bigIntBytes(deadline),
        relayer,
        bigIntBytes(minGas),
      ]),
    );
  } catch (e) {
    if (e instanceof EvmSponsorError) fail('invalid_value', e.message);
    throw e;
  }
}

function bytesItem(item: RlpDecoded | undefined, what: string): Uint8Array {
  if (!(item instanceof Uint8Array)) fail('malformed', `${what} must be an RLP string`);
  return item;
}

function listItem(item: RlpDecoded | undefined, what: string): RlpDecoded[] {
  if (!Array.isArray(item)) fail('malformed', `${what} must be an RLP list`);
  return item;
}

function address(item: RlpDecoded | undefined, what: string, nonZero: boolean): Hex {
  const b = bytesItem(item, what);
  if (b.length !== 20) fail('invalid_value', `${what} must be 20 bytes`);
  if (nonZero && isZero(b)) fail('invalid_value', `${what} must not be the zero address`);
  return checksumEvmAddress(b);
}

function scalar(item: RlpDecoded | undefined, what: string, max: bigint): bigint {
  const n = rlpScalar(item, what, 32);
  if (n > max) fail('invalid_value', `${what} is out of range`);
  return n;
}

/** Decodes subject bytes strictly (see the module comment). Throws DecodeError for anything it refuses. */
export function decodeSponsorSubject(input: Uint8Array): EvmSponsorSubject {
  if (!(input instanceof Uint8Array)) fail('malformed', 'Subject must be bytes');
  if (input.length > EVM_SPONSOR_SUBJECT_MAX_BYTES) fail('too_large', 'Subject is too large');
  const bytes = Uint8Array.from(input); // decoded from this copy only
  if (bytes.length < PREFIX.length || !PREFIX.every((b, i) => bytes[i] === b)) fail('malformed', 'Not an EVM sponsored-action subject');
  const root = listItem(decodeRlp(bytes.subarray(PREFIX.length)), 'subject');
  if (root.length !== 9) fail('malformed', 'Subject must have exactly 9 fields');
  const [chainIdItem, accountItem, delegateItem, authItem, callsItem, nonceItem, deadlineItem, relayerItem, minGasItem] = root;

  const chainId = scalar(chainIdItem, 'chainId', BigInt(Number.MAX_SAFE_INTEGER));
  if (chainId === 0n) fail('invalid_value', 'chainId must be positive');

  const auth = listItem(authItem, 'authNonce');
  if (auth.length > 1) fail('malformed', 'authNonce must be [] or [nonce]');
  const authNonce = auth.length === 0 ? null : scalar(auth[0], 'authNonce', AUTHORIZATION_NONCE_MAX);

  const account = address(accountItem, 'account', true);
  const delegate = address(delegateItem, 'delegate', true);
  const accountLower = account.toLowerCase();
  const delegateLower = delegate.toLowerCase();

  const callItems = listItem(callsItem, 'calls');
  if (callItems.length === 0 || callItems.length > EVM_SPONSOR_MAX_CALLS) fail('invalid_value', `calls must hold 1 to ${EVM_SPONSOR_MAX_CALLS} calls`);
  const calls = callItems.map((ci, i) => {
    const c = listItem(ci, `calls[${i}]`);
    if (c.length !== 3) fail('malformed', `calls[${i}] must be [to, value, data]`);
    const to = address(c[0], `calls[${i}].to`, true);
    const toLower = to.toLowerCase();
    if (toLower === accountLower || toLower === delegateLower) fail('invalid_value', `calls[${i}].to cannot be the account itself or the delegate`);
    if (rlpScalar(c[1], `calls[${i}].value`, 32) !== 0n) fail('invalid_value', `calls[${i}].value must be 0`);
    const data = bytesItem(c[2], `calls[${i}].data`);
    if (data.length > EVM_SPONSOR_MAX_CALL_DATA_BYTES) fail('too_large', `calls[${i}].data is too large`);
    return Object.freeze({ to, value: 0n, data: `0x${toHex(data)}` as Hex });
  });

  const deadline = scalar(deadlineItem, 'deadline', U64_MAX);
  const minGas = scalar(minGasItem, 'minGas', U64_MAX);
  if (deadline === 0n || minGas === 0n) fail('invalid_value', 'deadline and minGas must be positive');

  return Object.freeze({
    chainId: Number(chainId),
    account,
    delegate,
    authNonce,
    calls: Object.freeze(calls),
    executeNonce: scalar(nonceItem, 'executeNonce', U64_MAX),
    deadline,
    relayer: address(relayerItem, 'relayer', true),
    minGas,
  });
}

/**
 * The approval request's `bytes` and `context` for a subject (kind `evm_sponsored`, D850): the subject's bytes and its
 * chain. The vault builds the subject (the API's prepare answer and its own manifest) and sends exactly these to the
 * popup, which decodes them itself; the approval digest binds every field, the authorization nonce included.
 */
export function sponsoredApprovalContent(s: EvmSponsorSubject): { readonly bytes: Bytes; readonly context: { readonly chainId: number } } {
  const bytes = encodeSponsorSubject(s);
  return { bytes, context: { chainId: decodeSponsorSubject(bytes).chainId } };
}

/** The Execute a subject describes (the delegate is the implementation). */
export function sponsorSubjectExecuteInput(s: EvmSponsorSubject): ExecuteInput {
  return Object.freeze({
    chainId: s.chainId,
    account: s.account,
    implementation: s.delegate,
    calls: s.calls,
    nonce: s.executeNonce,
    deadline: s.deadline,
    relayer: s.relayer,
    minGas: s.minGas,
  });
}

/** The authorization a subject asks for, or null when the account is already delegated. */
export function sponsorSubjectAuthorization(s: EvmSponsorSubject): Authorization | null {
  return s.authNonce === null ? null : Object.freeze({ chainId: s.chainId, address: s.delegate, nonce: s.authNonce });
}
