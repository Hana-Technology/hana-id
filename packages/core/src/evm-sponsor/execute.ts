// The delegate's Execute message (docs/decisions.md D846; contract interface D841): the EIP-712 typed data a user signs
// so the relayer can submit their batch of calls, and the `execute(...)` calldata that carries it. Byte for byte the
// contract's:
//   EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)
//     name "HanaDelegateExecutor", version "1", chainId = block.chainid,
//     verifyingContract = the user's account (address(this) under EIP-7702),
//     salt = bytes32(uint256(uint160(implementation)))  (binds the signature to that delegate's code)
//   Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)
// The typed data goes through normalizeTypedData and is hashed by hashTypedData (typed-data.ts), the repo's single
// EIP-712 parser and hasher, so it is the same object the approval popup and the vault read.
import { keccak_256 } from '@noble/hashes/sha3';
import { checksumEvmAddress } from '../addresses.ts';
import { type Bytes, concatBytes, from0xHex, toHex, utf8 } from '../bytes.ts';
import { type Hex, evmSignerAddress, recoverEvmAddress, signEvmDigest } from '../signers/evm.ts';
import { type NormalizedTypedData, hashTypedData, normalizeTypedData } from '../typed-data.ts';
import { SPONSOR_DELEGATE_DOMAIN, sponsorDelegate } from './delegates.ts';
import { refuse } from './errors.ts';
import {
  U256_MAX,
  U64_MAX,
  addressBytes,
  chainIdOf,
  checkSigningKey,
  dataBytes,
  hex0x,
  isZeroAddress,
  rsvParts,
  signerOptions,
  signing,
  uint,
  word32Hex,
} from './values.ts';

/** At most this many calls in one sponsored batch (and at least one: the contract refuses an empty batch). */
export const EVM_SPONSOR_MAX_CALLS = 8;
/** At most this many bytes of calldata per call. */
export const EVM_SPONSOR_MAX_CALL_DATA_BYTES = 8192;

export const EXECUTE_TYPE = 'Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)';
export const EXECUTE_FUNCTION = 'execute((address,uint256,bytes)[],uint256,uint256,address,uint256,bytes)';
/** The 4-byte selector of EXECUTE_FUNCTION. */
export const EXECUTE_SELECTOR: Hex = hex0x(keccak_256(utf8(EXECUTE_FUNCTION)).subarray(0, 4));

/** The typed-data `types` of an Execute, EIP712Domain first. */
export const EXECUTE_TYPES = Object.freeze({
  EIP712Domain: Object.freeze([
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ]),
  Execute: Object.freeze([
    { name: 'calls', type: 'Call[]' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'relayer', type: 'address' },
    { name: 'minGas', type: 'uint256' },
  ]),
  Call: Object.freeze([
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
  ]),
});

export interface ExecuteCall {
  readonly to: Hex;
  /** Wei. The builders accept any uint256 (the contract does); signExecute and the subject allow only 0. */
  readonly value: bigint;
  readonly data: Hex;
}

export interface ExecuteInput {
  readonly chainId: number;
  /** The user's account: the domain's verifyingContract. */
  readonly account: Hex;
  /** The delegate the account runs: the domain's salt. */
  readonly implementation: Hex;
  readonly calls: readonly ExecuteCall[];
  /** The account's Execute nonce (the delegate's sequential nonce, not its transaction nonce). */
  readonly nonce: bigint;
  /** Unix seconds; the contract refuses the batch after it. */
  readonly deadline: bigint;
  /** The only address that may submit it (never zero). */
  readonly relayer: Hex;
  /** The gas the batch must have left when it starts. */
  readonly minGas: bigint;
}

interface Parsed {
  chainId: number;
  account: Bytes;
  implementation: Bytes;
  calls: { to: Bytes; value: bigint; data: Bytes }[];
  nonce: bigint;
  deadline: bigint;
  relayer: Bytes;
  minGas: bigint;
}

function parse(input: ExecuteInput): Parsed {
  if (typeof input !== 'object' || input === null) refuse('invalid_input', 'Execute input must be an object');
  const chainId = chainIdOf(input.chainId);
  const account = addressBytes(input.account, 'account');
  const implementation = addressBytes(input.implementation, 'implementation');
  const relayer = addressBytes(input.relayer, 'relayer');
  if (isZeroAddress(account) || isZeroAddress(implementation)) refuse('invalid_input', 'account and implementation must not be the zero address');
  if (isZeroAddress(relayer)) refuse('invalid_input', 'relayer must not be the zero address');
  const rawCalls: unknown = input.calls;
  const count = Array.isArray(rawCalls) ? rawCalls.length : 0;
  if (count === 0 || count > EVM_SPONSOR_MAX_CALLS) refuse('invalid_input', `calls must hold 1 to ${EVM_SPONSOR_MAX_CALLS} calls`);
  const calls: Parsed['calls'] = [];
  for (let i = 0; i < count; i++) {
    const c: unknown = (rawCalls as unknown[])[i];
    if (typeof c !== 'object' || c === null) refuse('invalid_input', 'A call must be an object');
    const call = c as ExecuteCall;
    calls.push({ to: addressBytes(call.to, 'call.to'), value: uint(call.value, U256_MAX, 'call.value'), data: dataBytes(call.data, EVM_SPONSOR_MAX_CALL_DATA_BYTES, 'call.data') });
  }
  return {
    chainId,
    account,
    implementation,
    calls,
    nonce: uint(input.nonce, U64_MAX, 'nonce'),
    deadline: uint(input.deadline, U64_MAX, 'deadline'),
    relayer,
    minGas: uint(input.minGas, U64_MAX, 'minGas'),
  };
}

/**
 * The Execute as normalized typed data (normalizeTypedData's output over the JSON a dapp would send), ready for
 * hashTypedData and the approval popup's typed-data view. Refuses (EvmSponsorError) a malformed field, chainId 0, a
 * zero account, implementation or relayer, 0 or more than 8 calls and calldata over 8 KiB.
 */
export const executeTypedData = (input: ExecuteInput): NormalizedTypedData => typedDataOf(parse(input));

function typedDataOf(p: Parsed): NormalizedTypedData {
  const json = JSON.stringify({
    types: EXECUTE_TYPES,
    primaryType: 'Execute',
    domain: {
      name: SPONSOR_DELEGATE_DOMAIN.name,
      version: SPONSOR_DELEGATE_DOMAIN.version,
      chainId: String(p.chainId),
      verifyingContract: hex0x(p.account),
      salt: `0x${'00'.repeat(12)}${toHex(p.implementation)}`,
    },
    message: {
      calls: p.calls.map((c) => ({ to: hex0x(c.to), value: c.value.toString(), data: hex0x(c.data) })),
      nonce: p.nonce.toString(),
      deadline: p.deadline.toString(),
      relayer: hex0x(p.relayer),
      minGas: p.minGas.toString(),
    },
  });
  return normalizeTypedData(json);
}

const digestOf = (p: Parsed): Bytes => Uint8Array.from(hashTypedData(typedDataOf(p)));

/** The 32-byte EIP-712 digest of the Execute, as the contract computes it. */
export const executeDigest = (input: ExecuteInput): Bytes => digestOf(parse(input));

// ---- ABI encoding of execute(Call[] calls, uint256 nonce, uint256 deadline, address relayer, uint256 minGas, bytes signature) ----

const word = (n: bigint): Bytes => from0xHex(word32Hex(n));
const addressWord = (a: Bytes): Bytes => concatBytes(new Uint8Array(12), a);
const padded = (b: Bytes): Bytes => concatBytes(b, new Uint8Array((32 - (b.length % 32)) % 32));
/** A dynamic `bytes` tail: length word ‖ the bytes, right-padded to a word. */
const bytesTail = (b: Bytes): Bytes => concatBytes(word(BigInt(b.length)), padded(b));

/** A copy of a well-formed 65-byte signature (checked on the copy). */
function signatureBytes(signature: Hex | Uint8Array): Bytes {
  const sig = signature instanceof Uint8Array ? Uint8Array.from(signature) : typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/u.test(signature) ? from0xHex(signature) : null;
  if (sig === null) refuse('invalid_signature', 'Signature must be 65 bytes r ‖ s ‖ v');
  rsvParts(sig);
  return sig;
}

/**
 * The `execute(...)` calldata for this Execute and its 65-byte `r ‖ s ‖ v` signature: the bytes the relayer sends to
 * the user's account. The signature must be well formed (v 27 or 28, low s); it is not checked against the digest.
 */
export function encodeExecuteCalldata(input: ExecuteInput, signature: Hex | Uint8Array): Hex {
  const p = parse(input);
  const sig = signatureBytes(signature);
  // Call[]: length ‖ one offset per element (from the start of the offsets) ‖ each (to, value, offset 0x60, data).
  const elements = p.calls.map((c) => concatBytes(addressWord(c.to), word(c.value), word(0x60n), bytesTail(c.data)));
  const offsets: Bytes[] = [];
  let at = 32n * BigInt(elements.length);
  for (const e of elements) {
    offsets.push(word(at));
    at += BigInt(e.length);
  }
  const callsTail = concatBytes(word(BigInt(elements.length)), ...offsets, ...elements);
  const head = 6n * 32n;
  return hex0x(
    concatBytes(
      from0xHex(EXECUTE_SELECTOR),
      word(head),
      word(p.nonce),
      word(p.deadline),
      addressWord(p.relayer),
      word(p.minGas),
      word(head + BigInt(callsTail.length)),
      callsTail,
      bytesTail(sig),
    ),
  );
}

/** The EIP-55 address that made this Execute signature. Refuses a malformed signature, v other than 27/28 and a high s. */
export function recoverExecuteSigner(input: ExecuteInput, signature: Hex | Uint8Array): Hex {
  const sig = signatureBytes(signature);
  return recoverEvmAddress(executeDigest(input), sig);
}

export interface SignExecuteOptions {
  /** The chains the caller has sponsorship switched on for. */
  readonly enabledChains: readonly number[];
  /**
   * TESTS ONLY: also sign for a chain whose pinned entry is a placeholder (not a deployed contract). Without it a
   * placeholder entry is refused. No production code passes it (a test checks the repo's sources).
   */
  readonly allowPlaceholderDelegateInTests?: true;
}

/**
 * True for a call target a sponsored batch never names: the zero address, the account itself (its own delegate
 * functions) or the delegate's implementation address. The app allowlist is the main control; this is a second one.
 */
export function isForbiddenSponsorTarget(to: Uint8Array, account: Uint8Array, delegate: Uint8Array): boolean {
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  return isZeroAddress(to) || same(to, account) || same(to, delegate);
}

/**
 * Signs an Execute with the user's key `d` and returns the 65-byte `r ‖ s ‖ v` signature (`0x` hex, v 27 or 28, low
 * s). Refuses (EvmSponsorError), besides everything executeTypedData refuses: an invalid key, a chain outside
 * `enabledChains` or without a pinned delegate, a placeholder delegate (unless the test-only option is given), an
 * implementation other than that chain's pinned delegate, an account other than this key's address, a deadline or
 * minGas of 0, any call with value, and any call to the zero address, the account itself or the delegate.
 */
export function signExecute(d: Uint8Array, input: ExecuteInput, options: SignExecuteOptions): Hex {
  checkSigningKey(d);
  const p = parse(input);
  const { enabled, allowPlaceholder } = signerOptions(options, false);
  const pinned = sponsorDelegate(p.chainId);
  if (!enabled.has(p.chainId) || pinned === null) refuse('chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (pinned.placeholder && !allowPlaceholder) refuse('delegate_not_pinned', 'The delegate on this chain is a test placeholder');
  if (hex0x(p.implementation) !== pinned.address.toLowerCase()) refuse('delegate_not_pinned', 'Only the pinned delegate can be named on this chain');
  if (p.deadline === 0n || p.minGas === 0n) refuse('invalid_input', 'deadline and minGas must be positive');
  if (p.calls.some((c) => c.value !== 0n)) refuse('value_not_allowed', 'Sponsored calls carry no value');
  if (p.calls.some((c) => isForbiddenSponsorTarget(c.to, p.account, p.implementation))) {
    refuse('invalid_input', 'A sponsored call cannot target the zero address, the account itself or the delegate');
  }
  if (checksumEvmAddress(p.account) !== signing(() => evmSignerAddress(d))) refuse('not_own_account', 'The Execute is for another account');
  return hex0x(signing(() => signEvmDigest(d, digestOf(p))));
}
