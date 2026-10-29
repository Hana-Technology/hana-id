// EVM signers (docs/batch-b-spec.md "Signing and approval", "What gets signed"). Each takes the 32-byte secp256k1 key
// `d` that derivation.ts withChainKey hands it for one signature, and never keeps it. Built on @noble/curves and
// @noble/hashes only (RLP is a few lines); test/signers.test.ts checks every output against viem.
//
// - transaction: EIP-1559 (type 2) or legacy with an EIP-155 chain ID. The port carries every field as a JSON-RPC
//   `0x` hex string, fully filled by the SDK; parseEvmTxRequest refuses anything else.
// - personal_sign: EIP-191 (version 0x45), keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ message).
// - eth_signTypedData_v4: EIP-712 over normalizeTypedData's output, hashed by typed-data.ts, the single parser (the one
//   the popup renders from; sweep CORE-5: the looser second hasher is gone from the package).
// - raw: secp256k1 over a 32-byte digest. It can sign any EVM transaction; only under raw approval.
// Signatures are RFC 6979 deterministic with low s; `r ‖ s ‖ v` has v ∈ {27, 28}.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { checksumEvmAddress, evmAddress, parseEvmAddress } from '../addresses.ts';
import { type Bytes, concatBytes, from0xHex, toBytes, toHex, utf8 } from '../bytes.ts';
import { type NormalizedTypedData, hashTypedData } from '../typed-data.ts';

export type Hex = `0x${string}`;

const U64_MAX = (1n << 64n) - 1n;
const U256_MAX = (1n << 256n) - 1n;

// ---- RLP (Ethereum Yellow Paper, appendix B) ----

export type RlpItem = Uint8Array | readonly RlpItem[];

function rlpLength(len: number, offset: number): Bytes {
  if (len < 56) return Uint8Array.of(offset + len);
  const be = bigIntBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + be.length), be);
}

/** RLP encoding of a byte string or a (nested) list. */
export function rlpEncode(item: RlpItem): Bytes {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return toBytes(item);
    return concatBytes(rlpLength(item.length, 0x80), item);
  }
  const payload = concatBytes(...item.map(rlpEncode));
  return concatBytes(rlpLength(payload.length, 0xc0), payload);
}

/** Minimal big-endian bytes of a non-negative integer (0 → empty), as RLP encodes scalars. */
export function bigIntBytes(n: bigint): Bytes {
  if (n < 0n) throw new RangeError('Negative integer');
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return from0xHex(`0x${hex}`);
}

function bigIntTo32(n: bigint): Bytes {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

// ---- transaction request (port shape) ----

export interface EvmAccessListEntry {
  address: Bytes;
  storageKeys: Bytes[];
}

export interface Eip1559Tx {
  type: 'eip1559';
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  /** null = contract creation. */
  to: Bytes | null;
  value: bigint;
  data: Bytes;
  accessList: EvmAccessListEntry[];
}

export interface LegacyTx {
  type: 'legacy';
  chainId: bigint;
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: Bytes | null;
  value: bigint;
  data: Bytes;
}

export type EvmTx = Eip1559Tx | LegacyTx;

/** `eth_signTransaction` params.tx as it crosses the port: JSON-RPC hex strings. */
export interface EvmTxRequest {
  type?: '0x2' | '0x0';
  from?: string;
  chainId: string;
  nonce: string;
  gas: string;
  to?: string | null;
  value: string;
  data: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  accessList?: { address: string; storageKeys: string[] }[];
}

const TX_FIELDS = new Set(['type', 'from', 'chainId', 'nonce', 'gas', 'to', 'value', 'data', 'maxFeePerGas', 'maxPriorityFeePerGas', 'gasPrice', 'accessList']);
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/u;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function quantity(tx: Record<string, unknown>, field: string, max: bigint): bigint {
  const v = tx[field];
  if (typeof v !== 'string' || !QUANTITY.test(v)) throw new Error(`tx.${field} must be a 0x hex quantity`);
  const n = BigInt(v);
  if (n > max) throw new RangeError(`tx.${field} is out of range`);
  return n;
}

function hexData(v: unknown, what: string): Bytes {
  if (typeof v !== 'string' || !DATA.test(v)) throw new Error(`${what} must be 0x hex bytes`);
  return from0xHex(v);
}

/**
 * Validates and parses the port's transaction object. Exact field set; EIP-1559 needs both fee fields and no
 * gasPrice, legacy needs gasPrice and neither fee field; `type`, if present, must agree. `chainId` is required (EIP-155)
 * and at most Number.MAX_SAFE_INTEGER.
 */
export function parseEvmTxRequest(raw: unknown): EvmTx {
  if (!isObj(raw)) throw new Error('tx must be an object');
  for (const k of Object.keys(raw)) if (!TX_FIELDS.has(k)) throw new Error(`Unknown tx field: ${k}`);
  for (const k of ['chainId', 'nonce', 'gas', 'value', 'data']) if (raw[k] === undefined) throw new Error(`tx.${k} is required`);
  const is1559 = raw.maxFeePerGas !== undefined || raw.maxPriorityFeePerGas !== undefined;
  if (is1559 && raw.gasPrice !== undefined) throw new Error('tx has both gasPrice and EIP-1559 fees');
  if (!is1559 && raw.gasPrice === undefined) throw new Error('tx needs gasPrice or maxFeePerGas and maxPriorityFeePerGas');
  if (raw.type !== undefined && raw.type !== (is1559 ? '0x2' : '0x0')) throw new Error('tx.type does not match its fee fields');
  if (raw.from !== undefined) {
    if (typeof raw.from !== 'string') throw new Error('tx.from must be an address');
    parseEvmAddress(raw.from);
  }
  if (raw.to !== undefined && raw.to !== null && typeof raw.to !== 'string') throw new Error('tx.to must be an address');

  // A safe integer, as the approval context and digest carry it (approvalContextString): a larger chainId is refused
  // here, so parsePortRequest refuses the request instead of the approval path failing later.
  const chainId = quantity(raw, 'chainId', BigInt(Number.MAX_SAFE_INTEGER));
  if (chainId === 0n) throw new RangeError('tx.chainId must be positive');
  const nonce = quantity(raw, 'nonce', U64_MAX - 1n);
  const gas = quantity(raw, 'gas', U64_MAX);
  const value = quantity(raw, 'value', U256_MAX);
  const data = hexData(raw.data, 'tx.data');
  const to = typeof raw.to === 'string' ? parseEvmAddress(raw.to) : null;

  if (!is1559) {
    if (raw.accessList !== undefined) throw new Error('Legacy transactions have no accessList');
    return { type: 'legacy', chainId, nonce, gasPrice: quantity(raw, 'gasPrice', U256_MAX), gas, to, value, data };
  }
  const maxFeePerGas = quantity(raw, 'maxFeePerGas', U256_MAX);
  const maxPriorityFeePerGas = quantity(raw, 'maxPriorityFeePerGas', U256_MAX);
  if (maxPriorityFeePerGas > maxFeePerGas) throw new RangeError('tx.maxPriorityFeePerGas exceeds maxFeePerGas');
  return { type: 'eip1559', chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList: parseAccessList(raw.accessList) };
}

function parseAccessList(v: unknown): EvmAccessListEntry[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error('tx.accessList must be an array');
  return v.map((e, i) => {
    if (!isObj(e) || Object.keys(e).some((k) => k !== 'address' && k !== 'storageKeys')) throw new Error(`tx.accessList[${i}] must be {address, storageKeys}`);
    if (typeof e.address !== 'string' || !Array.isArray(e.storageKeys)) throw new Error(`tx.accessList[${i}] must be {address, storageKeys}`);
    return {
      address: parseEvmAddress(e.address),
      storageKeys: e.storageKeys.map((k) => {
        const key = hexData(k, `tx.accessList[${i}].storageKeys`);
        if (key.length !== 32) throw new Error(`tx.accessList[${i}].storageKeys entries must be 32 bytes`);
        return key;
      }),
    };
  });
}

const toField = (to: Bytes | null): Bytes => to ?? new Uint8Array(0);
const accessListItem = (list: EvmAccessListEntry[]): RlpItem => list.map((e) => [e.address, e.storageKeys]);

function unsignedFields(tx: EvmTx): RlpItem[] {
  if (tx.type === 'eip1559') {
    return [bigIntBytes(tx.chainId), bigIntBytes(tx.nonce), bigIntBytes(tx.maxPriorityFeePerGas), bigIntBytes(tx.maxFeePerGas), bigIntBytes(tx.gas), toField(tx.to), bigIntBytes(tx.value), tx.data, accessListItem(tx.accessList)];
  }
  return [bigIntBytes(tx.nonce), bigIntBytes(tx.gasPrice), bigIntBytes(tx.gas), toField(tx.to), bigIntBytes(tx.value), tx.data];
}

/** The bytes whose keccak256 the signature covers (type 2: 0x02 ‖ rlp(…); legacy: rlp(… ‖ chainId ‖ 0 ‖ 0)). */
export function evmTxSigningPayload(tx: EvmTx): Bytes {
  if (tx.type === 'eip1559') return concatBytes(Uint8Array.of(2), rlpEncode(unsignedFields(tx)));
  return rlpEncode([...unsignedFields(tx), bigIntBytes(tx.chainId), new Uint8Array(0), new Uint8Array(0)]);
}

export const evmTxSigningHash = (tx: EvmTx): Bytes => toBytes(keccak_256(evmTxSigningPayload(tx)));

/** The signed raw transaction for a signature with recovery bit `recovery`. */
export function serializeSignedEvmTx(tx: EvmTx, sig: { r: bigint; s: bigint; recovery: number }): Hex {
  const r = bigIntBytes(sig.r);
  const s = bigIntBytes(sig.s);
  if (tx.type === 'eip1559') return `0x${toHex(concatBytes(Uint8Array.of(2), rlpEncode([...unsignedFields(tx), bigIntBytes(BigInt(sig.recovery)), r, s])))}`;
  const v = tx.chainId * 2n + 35n + BigInt(sig.recovery);
  return `0x${toHex(rlpEncode([...unsignedFields(tx), bigIntBytes(v), r, s]))}`;
}

function checkKey(d: Uint8Array): void {
  if (d.length !== 32 || !secp256k1.utils.isValidPrivateKey(d)) throw new Error('Invalid secp256k1 private key');
}

/** EIP-55 address of `d`. */
export function evmSignerAddress(d: Uint8Array): Hex {
  checkKey(d);
  return evmAddress(secp256k1.getPublicKey(d, false));
}

function signDigest(d: Uint8Array, digest: Uint8Array): { r: bigint; s: bigint; recovery: number } {
  checkKey(d);
  if (digest.length !== 32) throw new Error('Digest must be 32 bytes');
  const sig = secp256k1.sign(digest, d, { lowS: true });
  return { r: sig.r, s: sig.s, recovery: sig.recovery };
}

const rsv = (sig: { r: bigint; s: bigint; recovery: number }): Bytes => concatBytes(bigIntTo32(sig.r), bigIntTo32(sig.s), Uint8Array.of(27 + sig.recovery));

/**
 * Signs the port's transaction object and returns the raw signed transaction. If the request names `from`, it must be
 * this key's address.
 */
export function signEvmTransaction(d: Uint8Array, request: unknown): Hex {
  const tx = parseEvmTxRequest(request);
  const from = (request as { from?: string }).from;
  if (from !== undefined && from.toLowerCase() !== evmSignerAddress(d).toLowerCase()) throw new Error('tx.from is not this account');
  return serializeSignedEvmTx(tx, signDigest(d, evmTxSigningHash(tx)));
}

/** EIP-191 personal message hash: keccak256("\x19Ethereum Signed Message:\n" ‖ decimal length ‖ message). */
export const eip191Hash = (message: Uint8Array): Bytes => toBytes(keccak_256(concatBytes(utf8(`\x19Ethereum Signed Message:\n${message.length}`), message)));

/** personal_sign: `0x` r‖s‖v (65 bytes). */
export const personalSign = (d: Uint8Array, message: Uint8Array): Hex => `0x${toHex(rsv(signDigest(d, eip191Hash(message))))}`;

/** eth_signTypedData_v4 over the normalized typed data: `0x` r‖s‖v (65 bytes). */
export const signTypedData = (d: Uint8Array, typedData: NormalizedTypedData): Hex => `0x${toHex(rsv(signDigest(d, hashTypedData(typedData))))}`;

/** Raw secp256k1 over a 32-byte digest: r‖s‖v (65 bytes), v ∈ {27, 28}. Can sign any EVM transaction. */
export const signEvmDigest = (d: Uint8Array, digest: Uint8Array): Bytes => rsv(signDigest(d, digest));

/** Recovers the EIP-55 address that made a 65-byte r‖s‖v signature (v ∈ {27, 28}) over `digest`. */
export function recoverEvmAddress(digest: Uint8Array, signature: Uint8Array): Hex {
  if (signature.length !== 65 || (signature[64] !== 27 && signature[64] !== 28)) throw new Error('Signature must be r‖s‖v with v ∈ {27, 28}');
  const sig = secp256k1.Signature.fromCompact(signature.subarray(0, 64)).addRecoveryBit(signature[64]! - 27);
  return checksumEvmAddress(keccak_256(sig.recoverPublicKey(digest).toRawBytes(false).subarray(1)).subarray(-20));
}
