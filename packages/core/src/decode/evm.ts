// EVM transaction decoder for the approval page and the auto-approve matcher. Input is the exact byte string the
// vault signs: the EIP-1559 payload `0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to,
// value, data, accessList])`, or the EIP-155 legacy preimage `rlp([nonce, gasPrice, gasLimit, to, value, data,
// chainId, 0, 0])`. Other types (EIP-2930, EIP-4844 blobs, EIP-7702 delegations) and pre-EIP-155 legacy transactions
// are refused, so the popup never shows something the vault would sign differently.
import { type AbiValue, decodeFunctionData } from './abi.ts';
import { fail } from './errors.ts';
import { checksumAddress, toHex0x } from './hex.ts';
import { type RlpItem, decodeRlp, rlpScalar } from './rlp.ts';
import { knownFunction } from './selectors.ts';

/** The decoded call when `data` starts with a known selector and decodes against its signature. */
export interface DecodedEvmCall {
  readonly selector: string;
  readonly signature: string;
  readonly name: string;
  readonly args: readonly AbiValue[];
}

interface DecodedEvmTxBase {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly gasLimit: bigint;
  /** EIP-55 address, or null for contract creation. */
  readonly to: string | null;
  readonly value: bigint;
  /** Calldata, `0x` hex. */
  readonly data: string;
  /** First 4 bytes of `data` (`0x` + 8 hex), or null when `data` is shorter. */
  readonly selector: string | null;
  /** Set when the selector is known and the calldata decodes against it; otherwise the page shows raw `data`. */
  readonly call: DecodedEvmCall | null;
  /** The most the sender can pay in fees: gasLimit × (maxFeePerGas or gasPrice). */
  readonly maxFeeWei: bigint;
}

export interface DecodedEip1559Tx extends DecodedEvmTxBase {
  readonly type: 'eip1559';
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly accessList: readonly { readonly address: string; readonly storageKeys: readonly string[] }[];
}

export interface DecodedLegacyTx extends DecodedEvmTxBase {
  readonly type: 'legacy';
  readonly gasPrice: bigint;
}

export type DecodedEvmTx = DecodedEip1559Tx | DecodedLegacyTx;

export const EVM_TX_MAX_BYTES = 192 * 1024;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function bytesItem(item: RlpItem | undefined, what: string): Uint8Array {
  if (!(item instanceof Uint8Array)) fail('malformed', `${what} must be an RLP string`);
  return item;
}

function toField(item: RlpItem | undefined): string | null {
  const b = bytesItem(item, 'to');
  if (b.length === 0) return null;
  if (b.length !== 20) fail('invalid_value', '"to" must be 20 bytes or empty');
  return checksumAddress(b);
}

function decodeCall(data: Uint8Array): Pick<DecodedEvmTxBase, 'selector' | 'call'> {
  if (data.length < 4) return { selector: null, call: null };
  const selector = toHex0x(data.subarray(0, 4));
  const fn = knownFunction(selector);
  if (!fn) return { selector, call: null };
  try {
    return { selector, call: { selector, signature: fn.signature, name: fn.name, args: decodeFunctionData(fn, data) } };
  } catch {
    // A known selector with calldata that doesn't decode: shown raw (and never auto-approved).
    return { selector, call: null };
  }
}

function chainIdOf(item: RlpItem | undefined): bigint {
  const id = rlpScalar(item, 'chainId');
  if (id === 0n || id > MAX_SAFE) fail('invalid_value', 'chainId must be a positive safe integer');
  return id;
}

/** Decodes an unsigned EIP-1559 or EIP-155 legacy transaction. Throws DecodeError. */
export function decodeEvmTransaction(bytes: Uint8Array): DecodedEvmTx {
  if (bytes.length === 0) fail('malformed', 'Empty transaction');
  if (bytes.length > EVM_TX_MAX_BYTES) fail('too_large', 'Transaction too large');
  const first = bytes[0] as number;
  if (first === 0x02) {
    const list = decodeRlp(bytes.subarray(1));
    if (!Array.isArray(list)) fail('malformed', 'EIP-1559 payload must be an RLP list');
    if (list.length !== 9) fail('malformed', 'EIP-1559 unsigned payload must have 9 fields');
    const [chainId, nonce, tip, maxFee, gas, to, value, data, accessList] = list;
    const dataBytes = bytesItem(data, 'data');
    if (!Array.isArray(accessList)) fail('malformed', 'accessList must be a list');
    const access = accessList.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[1])) {
        fail('malformed', 'Bad accessList entry');
      }
      const address = bytesItem(entry[0], 'accessList address');
      if (address.length !== 20) fail('invalid_value', 'accessList address must be 20 bytes');
      const keys = (entry[1] as RlpItem[]).map((k) => {
        const key = bytesItem(k, 'storage key');
        if (key.length !== 32) fail('invalid_value', 'Storage key must be 32 bytes');
        return toHex0x(key);
      });
      return Object.freeze({ address: checksumAddress(address), storageKeys: Object.freeze(keys) });
    });
    const maxFeePerGas = rlpScalar(maxFee, 'maxFeePerGas');
    const maxPriorityFeePerGas = rlpScalar(tip, 'maxPriorityFeePerGas');
    if (maxPriorityFeePerGas > maxFeePerGas) fail('invalid_value', 'maxPriorityFeePerGas exceeds maxFeePerGas');
    const gasLimit = rlpScalar(gas, 'gasLimit', 8);
    return Object.freeze({
      type: 'eip1559',
      chainId: chainIdOf(chainId),
      nonce: rlpScalar(nonce, 'nonce', 8),
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit,
      to: toField(to),
      value: rlpScalar(value, 'value'),
      data: toHex0x(dataBytes),
      accessList: Object.freeze(access),
      maxFeeWei: gasLimit * maxFeePerGas,
      ...decodeCall(dataBytes),
    });
  }
  if (first >= 0xc0) {
    const list = decodeRlp(bytes);
    if (!Array.isArray(list)) fail('malformed', 'Legacy transaction must be an RLP list');
    if (list.length === 6) fail('unsupported', 'Legacy transaction without an EIP-155 chain ID');
    if (list.length !== 9) fail('malformed', 'EIP-155 legacy preimage must have 9 fields');
    const [nonce, gasPrice, gas, to, value, data, chainId, r, s] = list;
    if (rlpScalar(r, 'r') !== 0n || rlpScalar(s, 's') !== 0n) fail('malformed', 'EIP-155 preimage must end in 0, 0');
    const dataBytes = bytesItem(data, 'data');
    const price = rlpScalar(gasPrice, 'gasPrice');
    const gasLimit = rlpScalar(gas, 'gasLimit', 8);
    return Object.freeze({
      type: 'legacy',
      chainId: chainIdOf(chainId),
      nonce: rlpScalar(nonce, 'nonce', 8),
      gasPrice: price,
      gasLimit,
      to: toField(to),
      value: rlpScalar(value, 'value'),
      data: toHex0x(dataBytes),
      maxFeeWei: gasLimit * price,
      ...decodeCall(dataBytes),
    });
  }
  if (first <= 0x7f) fail('unsupported', `Unsupported transaction type 0x${first.toString(16).padStart(2, '0')}`);
  fail('malformed', 'Not an EVM transaction');
}
