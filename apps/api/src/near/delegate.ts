// NEP-366 meta transactions (D730–D739): a strict borsh decoder for the `SignedDelegateAction` a Hana NEAR wallet
// signs, the relay policy it must meet, and the encoders for the relayer's own transactions (the `Delegate` action
// that carries it, and the zero `Transfer` that creates an implicit account). Pure: no Workers or Node imports, so the
// sandbox tests (test-sandbox/) run the same code against a real node.
//
// Only what the relay accepts is decoded: inner actions must be `FunctionCall`s; any other action tag is reported, not
// parsed. The decoder consumes the input exactly (no trailing bytes), so the bytes the relayer forwards are the bytes
// the user signed and this module checked: the Delegate action carries the input slice itself, never a re-encoding.
//
// Could later move to the shared NEAR codec in `@hana-id/core` (packages/core/src/near/, the core build); the relay
// keeps its own decoder for now so the two builds don't wait on each other.
import { baseDecode, baseEncode } from '@near-js/utils';
import { borshString, concatBytes, hex, sha256, u32le, u64le } from '../bytes.ts';

/** NEP-461: the u32 prefix of a signed delegate action's message, (1 << 30) + 366. */
export const DELEGATE_ACTION_PREFIX = 2 ** 30 + 366;
/** Accounts are at most 64 bytes (NEAR's account id rules). */
const MAX_ACCOUNT_LEN = 64;
/** A method name is at most 256 bytes (the runtime's `max_length_method_name`). */
const MAX_METHOD_LEN = 256;
/** At most this many inner actions; the relay only needs one (a guestbook message). */
export const MAX_INNER_ACTIONS = 4;
/** A whole signed delegate action, at most (the guestbook's 200-character text fits many times over). */
export const MAX_SIGNED_DELEGATE_BYTES = 4096;
/** 1 Tgas. */
export const TGAS = 10n ** 12n;
/** Nonces of an access key are bounded by block height × 10^6 (the runtime's ACCESS_KEY_NONCE_RANGE_MULTIPLIER). */
export const NONCE_RANGE_MULTIPLIER = 1_000_000n;
/**
 * Gas a relay burns beyond its inner calls (the transaction's conversion, the Delegate receipt, the function-call base
 * fees): about 2 Tgas measured on near-sandbox 2.13.4 for one call (test-sandbox/meta-tx.test.ts); the budget counts 5.
 */
export const RELAY_OVERHEAD_GAS = 5n * TGAS;
/**
 * An activation's worst case for the budget. A zero Transfer that creates an implicit account burns about 71 Tgas
 * (0.0071 NEAR at the minimum gas price: the receipt on the new account burns 70.3 Tgas, measured on near-sandbox
 * 2.13.4, protocol 86), against 8.3 Tgas for the same Transfer to an existing account; the budget counts 100.
 */
export const ACTIVATE_GAS = 100n * TGAS;

/** The action tags of nearcore's `Action` enum, for the refusal message only. */
const ACTION_NAMES = ['CreateAccount', 'DeployContract', 'FunctionCall', 'Transfer', 'Stake', 'AddKey', 'DeleteKey', 'DeleteAccount', 'Delegate', 'DeployGlobalContract', 'UseGlobalContract', 'DeterministicStateInit'];
const FUNCTION_CALL = 2;

export interface InnerFunctionCall {
  methodName: string;
  args: Uint8Array;
  gas: bigint;
  deposit: bigint;
}

export interface DecodedDelegate {
  senderId: string;
  receiverId: string;
  /** The inner actions; every one a FunctionCall when `otherAction` is null. */
  actions: InnerFunctionCall[];
  /** The first action that is not a FunctionCall (its index and name), which stops the decode there. */
  otherAction: { index: number; name: string } | null;
  nonce: bigint;
  maxBlockHeight: bigint;
  /** The 32-byte Ed25519 public key (only Ed25519 is accepted: a Hana NEAR key is Ed25519). */
  publicKey: Uint8Array;
  signature: Uint8Array;
  /** borsh(DelegateAction): the bytes the signature covers after the NEP-461 prefix. */
  delegateBytes: Uint8Array;
  /** The whole input, borsh(SignedDelegateAction). */
  signedBytes: Uint8Array;
}

export type DecodeError = 'too_large' | 'truncated' | 'trailing_bytes' | 'bad_account' | 'bad_method' | 'key_type' | 'signature_type' | 'too_many_actions';

class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  get offset(): number {
    return this.at;
  }
  get done(): boolean {
    return this.at === this.b.length;
  }
  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new DecodeFailure('truncated');
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u32(): number {
    const v = this.take(4);
    return (v[0]! | (v[1]! << 8) | (v[2]! << 16)) + v[3]! * 2 ** 24;
  }
  u64(): bigint {
    return this.uint(8);
  }
  u128(): bigint {
    return this.uint(16);
  }
  private uint(n: number): bigint {
    const v = this.take(n);
    let x = 0n;
    for (let i = n - 1; i >= 0; i--) x = (x << 8n) | BigInt(v[i]!);
    return x;
  }
  /** A borsh string of at most `max` bytes, valid UTF-8. */
  string(max: number, err: DecodeError): string {
    const len = this.u32();
    if (len > max) throw new DecodeFailure(err);
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.take(len));
    } catch (e) {
      if (e instanceof DecodeFailure) throw e;
      throw new DecodeFailure(err);
    }
  }
}

class DecodeFailure extends Error {
  constructor(readonly code: DecodeError) {
    super(code);
  }
}

/** NEAR account id rules (2–64 characters of lowercase letters, digits and the `-_.` separators). */
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u;
/** An implicit account: lowercase hex of a 32-byte Ed25519 public key. */
export const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/u;

function account(r: Reader): string {
  const id = r.string(MAX_ACCOUNT_LEN, 'bad_account');
  if (!NEAR_ACCOUNT_RE.test(id)) throw new DecodeFailure('bad_account');
  return id;
}

/**
 * Decodes borsh(SignedDelegateAction) strictly: DelegateAction { sender_id, receiver_id, actions: Vec<Action>, nonce:
 * u64, max_block_height: u64, public_key } ‖ Signature. Ed25519 key and signature only. Decoding stops at the first
 * action that is not a FunctionCall (its body isn't parsed; `otherAction` names it), which the policy then refuses.
 */
export function decodeSignedDelegate(bytes: Uint8Array): { ok: true; value: DecodedDelegate } | { ok: false; error: DecodeError } {
  if (bytes.length > MAX_SIGNED_DELEGATE_BYTES) return { ok: false, error: 'too_large' };
  const r = new Reader(bytes);
  try {
    const senderId = account(r);
    const receiverId = account(r);
    const count = r.u32();
    if (count > MAX_INNER_ACTIONS) throw new DecodeFailure('too_many_actions');
    const actions: InnerFunctionCall[] = [];
    let otherAction: DecodedDelegate['otherAction'] = null;
    for (let i = 0; i < count; i++) {
      const tag = r.u8();
      if (tag !== FUNCTION_CALL) {
        otherAction = { index: i, name: ACTION_NAMES[tag] ?? `action ${tag}` };
        break;
      }
      const methodName = r.string(MAX_METHOD_LEN, 'bad_method');
      if (!/^[A-Za-z0-9_]{1,256}$/u.test(methodName)) throw new DecodeFailure('bad_method');
      const args = r.take(r.u32());
      const gas = r.u64();
      const deposit = r.u128();
      actions.push({ methodName, args, gas, deposit });
    }
    if (otherAction) {
      // The rest isn't parsed; what matters is that it is refused.
      return { ok: true, value: { senderId, receiverId, actions, otherAction, nonce: 0n, maxBlockHeight: 0n, publicKey: new Uint8Array(32), signature: new Uint8Array(64), delegateBytes: new Uint8Array(0), signedBytes: bytes } };
    }
    const nonce = r.u64();
    const maxBlockHeight = r.u64();
    if (r.u8() !== 0) throw new DecodeFailure('key_type');
    const publicKey = r.take(32);
    const delegateEnd = r.offset;
    if (r.u8() !== 0) throw new DecodeFailure('signature_type');
    const signature = r.take(64);
    if (!r.done) throw new DecodeFailure('trailing_bytes');
    return {
      ok: true,
      value: { senderId, receiverId, actions, otherAction: null, nonce, maxBlockHeight, publicKey: Uint8Array.from(publicKey), signature: Uint8Array.from(signature), delegateBytes: bytes.slice(0, delegateEnd), signedBytes: bytes },
    };
  } catch (e) {
    if (e instanceof DecodeFailure) return { ok: false, error: e.code };
    throw e;
  }
}

/** What the sender's key signs: sha256(u32le(NEP-461 prefix) ‖ borsh(DelegateAction)). */
export async function delegateSigningHash(delegateBytes: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes(u32le(DELEGATE_ACTION_PREFIX), delegateBytes));
}

/**
 * The delegate's signature by its own public key (WebCrypto Ed25519, as the API's session signatures). A signature
 * nearcore would refuse anyway costs the relayer a failed receipt, never a relayed call.
 */
export async function verifyDelegateSignature(d: DecodedDelegate): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', d.publicKey as Uint8Array<ArrayBuffer>, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, d.signature as Uint8Array<ArrayBuffer>, (await delegateSigningHash(d.delegateBytes)) as Uint8Array<ArrayBuffer>);
  } catch {
    return false;
  }
}

/** `ed25519:<base58>`, as RPC views name a key. */
export const nearPublicKeyString = (pk: Uint8Array): string => `ed25519:${baseEncode(pk)}`;

export interface RelayPolicy {
  /** Receivers inner calls may go to (the manifest's `near.relay.receivers`). Empty: nothing is relayed. */
  receivers: readonly string[];
  /** Total gas the inner calls may attach, in gas units. */
  maxGas: bigint;
}

/** Why a decoded delegate is refused (each maps to an error code in relay.ts). */
export type PolicyRefusal =
  | { code: 'sender_not_implicit' }
  | { code: 'action_not_allowed'; index: number; action: string }
  | { code: 'no_actions' }
  | { code: 'deposit_not_allowed'; index: number }
  | { code: 'receiver_not_allowed'; receiverId: string }
  | { code: 'gas_too_high'; maxGas: bigint };

/**
 * The relay policy (D732): the sender is the implicit account of the delegate's own key; every inner action is a
 * FunctionCall with zero deposit (the relayer pays any deposit: measured on near-sandbox, D731); the receiver is on the
 * allowlist; the gas of all inner calls together is at most `maxGas` (the relayer prepays it). Null when it passes.
 * The signature is checked separately (verifyDelegateSignature).
 */
export function policyRefusal(d: DecodedDelegate, p: RelayPolicy): PolicyRefusal | null {
  if (!IMPLICIT_ACCOUNT_RE.test(d.senderId) || (!d.otherAction && d.senderId !== hex(d.publicKey))) return { code: 'sender_not_implicit' };
  if (d.otherAction) return { code: 'action_not_allowed', index: d.otherAction.index, action: d.otherAction.name };
  if (d.actions.length === 0) return { code: 'no_actions' };
  const deposit = d.actions.findIndex((a) => a.deposit !== 0n);
  if (deposit >= 0) return { code: 'deposit_not_allowed', index: deposit };
  if (!p.receivers.includes(d.receiverId)) return { code: 'receiver_not_allowed', receiverId: d.receiverId };
  const gas = d.actions.reduce((s, a) => s + a.gas, 0n);
  if (gas > p.maxGas) return { code: 'gas_too_high', maxGas: p.maxGas };
  return null;
}

export const innerGas = (d: DecodedDelegate): bigint => d.actions.reduce((s, a) => s + a.gas, 0n);

// ---- the relayer's transactions ----

/**
 * What the relayer signs: a Delegate action (tag 8) wrapping the signed delegate bytes as received, or the activation's
 * Transfer (tag 3) of `amount` yocto (0 by default: a zero Transfer creates an implicit account, D731).
 */
export type RelayAction = { kind: 'delegate'; signedDelegate: Uint8Array } | { kind: 'activate'; amount: bigint };

const U128_MAX = (1n << 128n) - 1n;

function actionBytes(a: RelayAction): Uint8Array {
  if (a.kind === 'delegate') return concatBytes(Uint8Array.of(8), a.signedDelegate);
  if (a.amount < 0n || a.amount > U128_MAX) throw new Error('A Transfer amount is a u128');
  return concatBytes(Uint8Array.of(3), u64le(a.amount & 0xffffffffffffffffn), u64le(a.amount >> 64n));
}

/**
 * borsh(Transaction) (V0): signer_id, public_key (Ed25519), nonce, receiver_id, block_hash, actions (one). Hand-encoded
 * so a Delegate action carries the exact bytes checked above; tests compare it with @near-js/transactions' encoder.
 */
export function encodeRelayTransaction(t: { signerId: string; publicKey: Uint8Array; nonce: bigint; receiverId: string; blockHash: string; action: RelayAction }): Uint8Array {
  const blockHash = baseDecode(t.blockHash);
  if (blockHash.length !== 32) throw new Error('A block hash is 32 bytes');
  if (t.publicKey.length !== 32) throw new Error('An Ed25519 public key is 32 bytes');
  if (t.nonce < 0n || t.nonce >= 1n << 64n) throw new Error('A nonce is a u64');
  return concatBytes(borshString(t.signerId), Uint8Array.of(0), t.publicKey, u64le(t.nonce), borshString(t.receiverId), blockHash, u32le(1), actionBytes(t.action));
}

/** borsh(SignedTransaction) = borsh(Transaction) ‖ Signature (Ed25519). */
export const encodeSignedTransaction = (tx: Uint8Array, signature: Uint8Array): Uint8Array => concatBytes(tx, Uint8Array.of(0), signature);
