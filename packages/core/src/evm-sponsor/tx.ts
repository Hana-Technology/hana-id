// The relayer's transactions (docs/decisions.md D846): an EIP-1559 (type 2) transaction to an account that is already
// delegated, or an EIP-7702 (type 4) one that carries the user's authorization and delegates it in the same
// transaction. The relayer signs these with its own key, never a user's. Type 2 reuses signers/evm.ts's serializer;
// type 4 is
//   0x04 ‖ rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, destination, value, data,
//               access_list, authorization_list, y_parity, r, s])
// with authorization_list = [[chain_id, address, nonce, y_parity, r, s], …] (EIP-7702). Both are checked strictly
// before anything is signed: fields in range, a destination always (no contract creation), the priority fee at most
// the max fee, and for type 4 one to 8 authorizations, each for this transaction's chain (never chainId 0) with a low s.
import { keccak_256 } from '@noble/hashes/sha3';
import { type Bytes, concatBytes, from0xHex } from '../bytes.ts';
import {
  type Eip1559Tx,
  type EvmAccessListEntry,
  type Hex,
  bigIntBytes,
  evmTxSigningHash,
  rlpEncode,
  type RlpItem,
  serializeSignedEvmTx,
  signEvmDigest,
} from '../signers/evm.ts';
import { type SignedAuthorization, authorizationListItem } from './authorization.ts';
import { refuse } from './errors.ts';
import { U256_MAX, U64_MAX, checkLowS, hex0x, uint } from './values.ts';

/** At most this many authorizations in one type-4 transaction. */
export const SPONSOR_TX_MAX_AUTHORIZATIONS = 8;
/** At most this many bytes of calldata in a relayer transaction. */
export const SPONSOR_TX_MAX_DATA_BYTES = 128 * 1024;

export interface Eip7702Tx {
  type: 'eip7702';
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gas: bigint;
  /** Always an address: EIP-7702 has no contract creation. */
  to: Bytes;
  value: bigint;
  data: Bytes;
  accessList: EvmAccessListEntry[];
  /** One to 8 signed authorizations, each for `chainId`. */
  authorizationList: readonly SignedAuthorization[];
}

/** A relayer transaction: type 2 (`to` required) or type 4. */
export type SponsorTx = Eip1559Tx | Eip7702Tx;

const bytes = (v: unknown, len: number | null, what: string): Bytes => {
  if (!(v instanceof Uint8Array) || (len !== null && v.length !== len)) refuse('invalid_input', `${what} must be ${len === null ? 'bytes' : `${len} bytes`}`);
  return Uint8Array.from(v);
};

const list = (v: unknown, max: number, what: string): unknown[] => {
  if (!Array.isArray(v) || v.length > max) refuse('invalid_input', `${what} must be an array of at most ${max}`);
  return Array.from({ length: v.length }, (_, i) => (v as unknown[])[i]);
};

/** A checked copy of the transaction: every field read once, byte arrays copied; signing and serializing use only it. */
interface Checked {
  type: 'eip1559' | 'eip7702';
  tx1559: Eip1559Tx;
  /** Type 4 only: the authorization list's RLP items. */
  authorizations: Uint8Array[][];
}

function checked(tx: SponsorTx): Checked {
  if (typeof tx !== 'object' || tx === null) refuse('invalid_input', 'tx must be an object');
  const type: unknown = tx.type;
  if (type !== 'eip1559' && type !== 'eip7702') refuse('invalid_input', 'tx.type must be eip1559 or eip7702');
  const chainId = uint(tx.chainId, BigInt(Number.MAX_SAFE_INTEGER), 'tx.chainId');
  if (chainId === 0n) refuse('chain_id_invalid', 'tx.chainId must be positive');
  const maxFeePerGas = uint(tx.maxFeePerGas, U256_MAX, 'tx.maxFeePerGas');
  const maxPriorityFeePerGas = uint(tx.maxPriorityFeePerGas, U256_MAX, 'tx.maxPriorityFeePerGas');
  if (maxPriorityFeePerGas > maxFeePerGas) refuse('invalid_input', 'tx.maxPriorityFeePerGas exceeds maxFeePerGas');
  const data = bytes(tx.data, null, 'tx.data');
  if (data.length > SPONSOR_TX_MAX_DATA_BYTES) refuse('invalid_input', 'tx.data is too large');
  const accessList: EvmAccessListEntry[] = list(tx.accessList, 64, 'tx.accessList').map((e) => {
    if (typeof e !== 'object' || e === null) refuse('invalid_input', 'tx.accessList entries must be {address, storageKeys}');
    const entry = e as EvmAccessListEntry;
    return { address: bytes(entry.address, 20, 'tx.accessList address'), storageKeys: list(entry.storageKeys, 64, 'tx.accessList storage keys').map((k) => bytes(k, 32, 'tx.accessList storage key')) };
  });
  const tx1559: Eip1559Tx = {
    type: 'eip1559',
    chainId,
    nonce: uint(tx.nonce, U64_MAX - 1n, 'tx.nonce'),
    maxPriorityFeePerGas,
    maxFeePerGas,
    gas: uint(tx.gas, U64_MAX, 'tx.gas'),
    to: bytes(tx.to, 20, 'tx.to'),
    value: uint(tx.value, U256_MAX, 'tx.value'),
    data,
    accessList,
  };
  if (type === 'eip1559') return { type, tx1559, authorizations: [] };
  const auths = list((tx as Eip7702Tx).authorizationList, SPONSOR_TX_MAX_AUTHORIZATIONS, 'tx.authorizationList');
  if (auths.length === 0) refuse('invalid_input', `tx.authorizationList must hold 1 to ${SPONSOR_TX_MAX_AUTHORIZATIONS} authorizations`);
  const authorizations = auths.map((a) => {
    // Refuses a malformed tuple, chainId 0, a bad yParity, r or s, and a high s.
    const { chainId: authChain, item } = authorizationListItem(a as SignedAuthorization);
    if (BigInt(authChain) !== chainId) refuse('chain_id_invalid', "An authorization must be for the transaction's chain");
    return item;
  });
  return { type, tx1559, authorizations };
}

const accessListItem = (entries: EvmAccessListEntry[]): RlpItem => entries.map((e) => [e.address, e.storageKeys]);

function unsigned7702(c: Checked): RlpItem[] {
  const t = c.tx1559;
  return [
    bigIntBytes(t.chainId),
    bigIntBytes(t.nonce),
    bigIntBytes(t.maxPriorityFeePerGas),
    bigIntBytes(t.maxFeePerGas),
    bigIntBytes(t.gas),
    t.to as Bytes,
    bigIntBytes(t.value),
    t.data,
    accessListItem(t.accessList),
    c.authorizations,
  ];
}

const signingHashOf = (c: Checked): Bytes =>
  c.type === 'eip1559' ? evmTxSigningHash(c.tx1559) : Uint8Array.from(keccak_256(concatBytes(Uint8Array.of(4), rlpEncode(unsigned7702(c)))));

function serializeChecked(c: Checked, yParity: 0 | 1, r: bigint, s: bigint): Hex {
  if (c.type === 'eip1559') return serializeSignedEvmTx(c.tx1559, { r, s, recovery: yParity });
  return hex0x(concatBytes(Uint8Array.of(4), rlpEncode([...unsigned7702(c), bigIntBytes(BigInt(yParity)), bigIntBytes(r), bigIntBytes(s)])));
}

/** The 32-byte hash the transaction's signature covers (type 4: keccak256(0x04 ‖ rlp(unsigned fields))). */
export const sponsorTxSigningHash = (tx: SponsorTx): Bytes => signingHashOf(checked(tx));

/** The raw signed transaction for a signature (yParity, r, s; low s) over sponsorTxSigningHash(tx). */
export function serializeSponsorTx(tx: SponsorTx, sig: { yParity: 0 | 1; r: bigint; s: bigint }): Hex {
  const c = checked(tx);
  if (typeof sig !== 'object' || sig === null) refuse('invalid_signature', 'Signature must be {yParity, r, s}');
  const { yParity, r, s } = sig as { yParity: unknown; r: unknown; s: unknown };
  if (yParity !== 0 && yParity !== 1) refuse('invalid_signature', 'yParity must be 0 or 1');
  if (typeof r !== 'bigint' || typeof s !== 'bigint') refuse('invalid_signature', 'r and s must be integers');
  checkLowS(r, s);
  return serializeChecked(c, yParity, r, s);
}

/** Signs a relayer transaction with the relayer's key `d` (low s) and returns the raw signed transaction. */
export function signSponsorTx(d: Uint8Array, tx: SponsorTx): Hex {
  const c = checked(tx);
  const sig = signEvmDigest(d, signingHashOf(c));
  return serializeChecked(c, sig[64] === 27 ? 0 : 1, BigInt(hex0x(sig.subarray(0, 32))), BigInt(hex0x(sig.subarray(32, 64))));
}

/** A signed raw transaction's hash (keccak256 of its bytes), as `eth_sendRawTransaction` returns it. */
export function sponsorTxHash(raw: Hex): Hex {
  if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/u.test(raw)) refuse('invalid_input', 'raw must be 0x hex bytes');
  return hex0x(keccak_256(from0xHex(raw)));
}
