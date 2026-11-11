// NEAR borsh codec (D721): Transaction, SignedTransaction, every Action, NEP-366 DelegateAction and
// SignedDelegateAction (with NEP-461's signing prefix), and NEP-413 sign-message payloads. The vault signs only bytes
// this decodes, and the approval popup shows only what it decoded, so it is strict:
// - trailing bytes, a length past the end, an option tag other than 0/1 and invalid UTF-8 are `malformed`;
// - an enum tag the current protocol doesn't define, or one Hana doesn't decode, is `unsupported` (never skipped);
// - account ids must be valid NEAR account ids (nearcore refuses others when it deserializes them);
// - inputs over NEAR_MAX_BYTES, more than NEAR_MAX_ACTIONS actions and over-long method names are `too_large`.
//
// Transaction format: the borsh `Transaction` (nearcore's TransactionV0): signer_id, public_key, nonce, receiver_id,
// block_hash, actions. nearcore also defines TransactionV1 (a leading 0x01 byte, then the same fields and a u64
// priority_fee), which the protocol doesn't accept yet: it is refused as `unsupported`, as are the actions newer than
// UseGlobalContract (tag 11 on: deterministic state init, gas keys) and access key permissions other than FunctionCall
// and FullAccess.
//
// Signing (what NEAR nodes verify): a transaction's signature is Ed25519 over sha256(borsh(Transaction)), which is
// also its hash; a delegate action's is over sha256(u32le(2^30 + 366) ‖ borsh(DelegateAction)); a NEP-413 message's
// is over sha256(u32le(2^31 + 413) ‖ borsh(Payload)).
import { base58 } from '@scure/base';
import { type NearKeyType, isNearAccountId, nearPublicKeyString } from '../addresses.ts';
import { type Bytes, concatBytes, sha256, u32le } from '../bytes.ts';
import { isDisplaySafeLine } from '../display-safe.ts';
import { fail } from '../decode/errors.ts';
import { BorshReader, BorshWriter } from './borsh.ts';

/** The most bytes any NEAR request may have (the port's sign-request cap, before base64). */
export const NEAR_MAX_BYTES = 192 * 1024;
/** nearcore's max_actions_per_receipt. */
export const NEAR_MAX_ACTIONS = 100;
/** nearcore's max_length_method_name. */
export const NEAR_MAX_METHOD_NAME_BYTES = 256;
/** nearcore's max_number_bytes_method_names (a function-call access key's method list, all names together). */
export const NEAR_MAX_METHOD_NAMES_BYTES = 2000;
/** NEP-461: the u32 that starts a signed delegate action's message (2^30 + 366). */
export const NEP366_SIGNING_PREFIX = 2 ** 30 + 366;
/** NEP-413: the u32 tag that starts a signed message's payload (2^31 + 413). */
export const NEP413_TAG = 2 ** 31 + 413;
/** NEP-413 recipients and callback URLs: one display-safe line of at most this many bytes. */
export const NEP413_MAX_FIELD_BYTES = 1024;

export interface NearPublicKey {
  readonly type: NearKeyType;
  readonly bytes: Bytes;
}

export interface NearSignature {
  readonly type: NearKeyType;
  /** 64 bytes (Ed25519) or 65 (secp256k1). */
  readonly bytes: Bytes;
}

export type NearAccessKeyPermission =
  | { readonly type: 'fullAccess' }
  | {
      readonly type: 'functionCall';
      /** yoctoNEAR the key may spend on gas, or null for no limit. */
      readonly allowance: bigint | null;
      readonly receiverId: string;
      /** Empty: every method of receiverId. */
      readonly methodNames: readonly string[];
    };

export type NearGlobalContractId = { readonly type: 'codeHash'; readonly hash: Bytes } | { readonly type: 'accountId'; readonly accountId: string };

export type NearAction =
  | { readonly type: 'createAccount' }
  | { readonly type: 'deployContract'; readonly code: Bytes }
  | { readonly type: 'functionCall'; readonly methodName: string; readonly args: Bytes; readonly gas: bigint; readonly deposit: bigint }
  | { readonly type: 'transfer'; readonly deposit: bigint }
  | { readonly type: 'stake'; readonly stake: bigint; readonly publicKey: NearPublicKey }
  | { readonly type: 'addKey'; readonly publicKey: NearPublicKey; readonly accessKey: { readonly nonce: bigint; readonly permission: NearAccessKeyPermission } }
  | { readonly type: 'deleteKey'; readonly publicKey: NearPublicKey }
  | { readonly type: 'deleteAccount'; readonly beneficiaryId: string }
  | { readonly type: 'delegate'; readonly signedDelegate: NearSignedDelegateAction }
  | { readonly type: 'deployGlobalContract'; readonly code: Bytes; readonly deployMode: 'codeHash' | 'accountId' }
  | { readonly type: 'useGlobalContract'; readonly contract: NearGlobalContractId };

export type NearActionType = NearAction['type'];

/** The action tags, in nearcore's `Action` enum order. */
export const NEAR_ACTION_TAGS: readonly NearActionType[] = [
  'createAccount',
  'deployContract',
  'functionCall',
  'transfer',
  'stake',
  'addKey',
  'deleteKey',
  'deleteAccount',
  'delegate',
  'deployGlobalContract',
  'useGlobalContract',
];

export interface NearTransaction {
  readonly signerId: string;
  readonly publicKey: NearPublicKey;
  readonly nonce: bigint;
  readonly receiverId: string;
  /** 32 bytes. */
  readonly blockHash: Bytes;
  readonly actions: readonly NearAction[];
}

export interface NearSignedTransaction {
  readonly transaction: NearTransaction;
  readonly signature: NearSignature;
}

export interface NearDelegateAction {
  readonly senderId: string;
  readonly receiverId: string;
  /** Never a `delegate` (NEP-366: a delegate action can't hold another). */
  readonly actions: readonly NearAction[];
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  readonly publicKey: NearPublicKey;
}

export interface NearSignedDelegateAction {
  readonly delegateAction: NearDelegateAction;
  readonly signature: NearSignature;
}

/** NEP-413's Payload. */
export interface Nep413Payload {
  readonly message: string;
  /** 32 bytes. */
  readonly nonce: Bytes;
  readonly recipient: string;
  readonly callbackUrl: string | null;
}

// ---- decoding ----

const KEY_TYPES: readonly NearKeyType[] = ['ed25519', 'secp256k1'];
const KEY_LENGTH = { ed25519: 32, secp256k1: 64 } as const;
const SIG_LENGTH = { ed25519: 64, secp256k1: 65 } as const;

function checkSize(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array)) fail('malformed', `${what} must be bytes`);
  if (bytes.length > NEAR_MAX_BYTES) fail('too_large', `${what} is over ${NEAR_MAX_BYTES} bytes`);
}

function accountId(r: BorshReader, what: string): string {
  const id = r.string(what, 64);
  if (!isNearAccountId(id)) fail('invalid_value', `${what} is not a valid NEAR account id`);
  return id;
}

function keyType(r: BorshReader, what: string): NearKeyType {
  const t = r.u8(`${what} key type`);
  const type = KEY_TYPES[t];
  if (!type) fail('unsupported', `${what} has key type ${t}`);
  return type;
}

function publicKey(r: BorshReader, what: string): NearPublicKey {
  const type = keyType(r, what);
  return { type, bytes: r.fixed(KEY_LENGTH[type], what) };
}

function signature(r: BorshReader, what: string): NearSignature {
  const type = keyType(r, what);
  return { type, bytes: r.fixed(SIG_LENGTH[type], what) };
}

function permission(r: BorshReader): NearAccessKeyPermission {
  const t = r.u8('access key permission');
  if (t === 1) return { type: 'fullAccess' };
  if (t !== 0) fail('unsupported', `Access key permission ${t} is not decoded`);
  const allowance = r.option('allowance') ? r.u128('allowance') : null;
  const receiverId = accountId(r, 'access key receiver_id');
  const n = r.vecLength('method names', NEAR_MAX_METHOD_NAMES_BYTES);
  const methodNames: string[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const name = r.string('method name', NEAR_MAX_METHOD_NAME_BYTES);
    total += new TextEncoder().encode(name).length;
    if (total > NEAR_MAX_METHOD_NAMES_BYTES) fail('too_large', `Method names are over ${NEAR_MAX_METHOD_NAMES_BYTES} bytes`);
    methodNames.push(name);
  }
  return { type: 'functionCall', allowance, receiverId, methodNames };
}

function actions(r: BorshReader, inDelegate: boolean): NearAction[] {
  const n = r.vecLength('actions', NEAR_MAX_ACTIONS);
  const out: NearAction[] = [];
  for (let i = 0; i < n; i++) out.push(action(r, inDelegate));
  return out;
}

function action(r: BorshReader, inDelegate: boolean): NearAction {
  const t = r.u8('action tag');
  const type = NEAR_ACTION_TAGS[t];
  if (!type) fail('unsupported', `NEAR action ${t} is not decoded`);
  switch (type) {
    case 'createAccount':
      return { type };
    case 'deployContract':
      return { type, code: r.vecU8('contract code') };
    case 'functionCall': {
      const methodName = r.string('method name', NEAR_MAX_METHOD_NAME_BYTES);
      const args = r.vecU8('arguments');
      return { type, methodName, args, gas: r.u64('gas'), deposit: r.u128('deposit') };
    }
    case 'transfer':
      return { type, deposit: r.u128('deposit') };
    case 'stake': {
      const stake = r.u128('stake');
      return { type, stake, publicKey: publicKey(r, 'stake public key') };
    }
    case 'addKey': {
      const pk = publicKey(r, 'added key');
      const nonce = r.u64('access key nonce');
      return { type, publicKey: pk, accessKey: { nonce, permission: permission(r) } };
    }
    case 'deleteKey':
      return { type, publicKey: publicKey(r, 'deleted key') };
    case 'deleteAccount':
      return { type, beneficiaryId: accountId(r, 'beneficiary_id') };
    case 'delegate':
      if (inDelegate) fail('invalid_value', 'A delegate action cannot hold another delegate action');
      return { type, signedDelegate: signedDelegateAction(r) };
    case 'deployGlobalContract': {
      const code = r.vecU8('global contract code');
      const mode = r.u8('global contract deploy mode');
      if (mode > 1) fail('unsupported', `Global contract deploy mode ${mode} is not decoded`);
      return { type, code, deployMode: mode === 0 ? 'codeHash' : 'accountId' };
    }
    case 'useGlobalContract': {
      const id = r.u8('global contract identifier');
      if (id === 0) return { type, contract: { type: 'codeHash', hash: r.fixed(32, 'global contract code hash') } };
      if (id === 1) return { type, contract: { type: 'accountId', accountId: accountId(r, 'global contract account') } };
      return fail('unsupported', `Global contract identifier ${id} is not decoded`);
    }
  }
}

function delegateAction(r: BorshReader): NearDelegateAction {
  const senderId = accountId(r, 'sender_id');
  const receiverId = accountId(r, 'receiver_id');
  const acts = actions(r, true);
  const nonce = r.u64('nonce');
  const maxBlockHeight = r.u64('max_block_height');
  return { senderId, receiverId, actions: acts, nonce, maxBlockHeight, publicKey: publicKey(r, 'public_key') };
}

function signedDelegateAction(r: BorshReader): NearSignedDelegateAction {
  const da = delegateAction(r);
  return { delegateAction: da, signature: signature(r, 'delegate signature') };
}

function transaction(r: BorshReader, bytes: Uint8Array): NearTransaction {
  // TransactionV1 is 0x01, then the fields: its second byte is the first of the signer id's length, never 0. A V0
  // starts with that u32 length (2..64), whose second byte is always 0 (nearcore tells them apart the same way).
  if (bytes.length >= 2 && bytes[0] === 1 && bytes[1] !== 0) fail('unsupported', 'NEAR TransactionV1 (with a priority fee) is not supported');
  const signerId = accountId(r, 'signer_id');
  const pk = publicKey(r, 'public_key');
  const nonce = r.u64('nonce');
  const receiverId = accountId(r, 'receiver_id');
  const blockHash = r.fixed(32, 'block_hash');
  return { signerId, publicKey: pk, nonce, receiverId, blockHash, actions: actions(r, false) };
}

/** Decodes a borsh `Transaction`. Throws DecodeError. */
export function decodeNearTransaction(bytes: Uint8Array): NearTransaction {
  checkSize(bytes, 'NEAR transaction');
  const r = new BorshReader(bytes);
  const tx = transaction(r, bytes);
  r.end('transaction');
  return tx;
}

/** Decodes a borsh `SignedTransaction`, with where its transaction's bytes end. Throws DecodeError. */
export function decodeNearSignedTransaction(bytes: Uint8Array): NearSignedTransaction & { readonly transactionLength: number } {
  checkSize(bytes, 'NEAR signed transaction');
  const r = new BorshReader(bytes);
  const tx = transaction(r, bytes);
  const transactionLength = r.offset;
  const sig = signature(r, 'transaction signature');
  r.end('signed transaction');
  return { transaction: tx, signature: sig, transactionLength };
}

/**
 * Decodes a borsh `DelegateAction` (NEP-366), without NEP-461's signing prefix (nearDelegateActionMessage adds it).
 * Throws DecodeError.
 */
export function decodeNearDelegateAction(bytes: Uint8Array): NearDelegateAction {
  checkSize(bytes, 'NEAR delegate action');
  if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === NEP366_SIGNING_PREFIX) {
    fail('malformed', 'NEAR delegate action starts with the NEP-461 signing prefix: send the DelegateAction alone');
  }
  const r = new BorshReader(bytes);
  const da = delegateAction(r);
  r.end('delegate action');
  return da;
}

/** Decodes a borsh `SignedDelegateAction`. Throws DecodeError. */
export function decodeNearSignedDelegateAction(bytes: Uint8Array): NearSignedDelegateAction {
  checkSize(bytes, 'NEAR signed delegate action');
  const r = new BorshReader(bytes);
  const sda = signedDelegateAction(r);
  r.end('signed delegate action');
  return sda;
}

/** Decodes NEP-413's `u32le(2^31 + 413) ‖ borsh(Payload)`, the bytes whose sha256 is signed. Throws DecodeError. */
export function decodeNep413Message(bytes: Uint8Array): Nep413Payload {
  checkSize(bytes, 'NEP-413 message');
  const r = new BorshReader(bytes);
  if (r.u32('NEP-413 tag') !== NEP413_TAG) fail('malformed', 'Not a NEP-413 message (wrong tag)');
  const message = r.string('message');
  const nonce = r.fixed(32, 'nonce');
  const recipient = r.string('recipient', NEP413_MAX_FIELD_BYTES);
  const callbackUrl = r.option('callbackUrl') ? r.string('callbackUrl', NEP413_MAX_FIELD_BYTES) : null;
  r.end('NEP-413 message');
  checkNep413Fields(recipient, callbackUrl);
  return { message, nonce, recipient, callbackUrl };
}

function checkNep413Fields(recipient: string, callbackUrl: string | null): void {
  if (recipient.length === 0 || !isDisplaySafeLine(recipient)) fail('invalid_value', 'NEP-413 recipient must be one line of visible text');
  if (callbackUrl !== null && (callbackUrl.length === 0 || !isDisplaySafeLine(callbackUrl))) fail('invalid_value', 'NEP-413 callbackUrl must be one line of visible text');
}

// ---- encoding ----

function writePublicKey(w: BorshWriter, pk: NearPublicKey): void {
  w.u8(KEY_TYPES.indexOf(pk.type)).fixed(pk.bytes, KEY_LENGTH[pk.type]);
}

function writeSignature(w: BorshWriter, s: NearSignature): void {
  w.u8(KEY_TYPES.indexOf(s.type)).fixed(s.bytes, SIG_LENGTH[s.type]);
}

function writeAccount(w: BorshWriter, id: string, what: string): void {
  if (!isNearAccountId(id)) throw new RangeError(`${what} is not a valid NEAR account id`);
  w.string(id);
}

function writeAction(w: BorshWriter, a: NearAction, inDelegate: boolean): void {
  const tag = NEAR_ACTION_TAGS.indexOf(a.type);
  if (tag < 0) throw new RangeError('Unknown NEAR action');
  w.u8(tag);
  switch (a.type) {
    case 'createAccount':
      return;
    case 'deployContract':
      w.vecU8(a.code);
      return;
    case 'functionCall':
      w.string(a.methodName).vecU8(a.args).u64(a.gas).u128(a.deposit);
      return;
    case 'transfer':
      w.u128(a.deposit);
      return;
    case 'stake':
      w.u128(a.stake);
      writePublicKey(w, a.publicKey);
      return;
    case 'addKey': {
      writePublicKey(w, a.publicKey);
      w.u64(a.accessKey.nonce);
      const p = a.accessKey.permission;
      if (p.type === 'fullAccess') {
        w.u8(1);
        return;
      }
      w.u8(0);
      if (p.allowance === null) w.u8(0);
      else w.u8(1).u128(p.allowance);
      writeAccount(w, p.receiverId, 'access key receiver_id');
      w.u32(p.methodNames.length);
      for (const m of p.methodNames) w.string(m);
      return;
    }
    case 'deleteKey':
      writePublicKey(w, a.publicKey);
      return;
    case 'deleteAccount':
      writeAccount(w, a.beneficiaryId, 'beneficiary_id');
      return;
    case 'delegate':
      if (inDelegate) throw new RangeError('A delegate action cannot hold another delegate action');
      writeSignedDelegate(w, a.signedDelegate);
      return;
    case 'deployGlobalContract':
      w.vecU8(a.code).u8(a.deployMode === 'codeHash' ? 0 : 1);
      return;
    case 'useGlobalContract':
      if (a.contract.type === 'codeHash') w.u8(0).fixed(a.contract.hash, 32);
      else {
        w.u8(1);
        writeAccount(w, a.contract.accountId, 'global contract account');
      }
      return;
  }
}

function writeActions(w: BorshWriter, list: readonly NearAction[], inDelegate: boolean): void {
  if (list.length > NEAR_MAX_ACTIONS) throw new RangeError(`More than ${NEAR_MAX_ACTIONS} actions`);
  w.u32(list.length);
  for (const a of list) writeAction(w, a, inDelegate);
}

function writeDelegate(w: BorshWriter, d: NearDelegateAction): void {
  writeAccount(w, d.senderId, 'sender_id');
  writeAccount(w, d.receiverId, 'receiver_id');
  writeActions(w, d.actions, true);
  w.u64(d.nonce).u64(d.maxBlockHeight);
  writePublicKey(w, d.publicKey);
}

function writeSignedDelegate(w: BorshWriter, s: NearSignedDelegateAction): void {
  writeDelegate(w, s.delegateAction);
  writeSignature(w, s.signature);
}

/** borsh(Transaction). */
export function encodeNearTransaction(tx: NearTransaction): Bytes {
  const w = new BorshWriter();
  writeAccount(w, tx.signerId, 'signer_id');
  writePublicKey(w, tx.publicKey);
  w.u64(tx.nonce);
  writeAccount(w, tx.receiverId, 'receiver_id');
  w.fixed(tx.blockHash, 32);
  writeActions(w, tx.actions, false);
  return w.bytes();
}

/** borsh(SignedTransaction): the transaction's own bytes, then the signature. */
export function encodeNearSignedTransaction(txBytes: Uint8Array, sig: NearSignature): Bytes {
  const w = new BorshWriter().raw(txBytes);
  writeSignature(w, sig);
  return w.bytes();
}

/** borsh(DelegateAction), without the signing prefix. */
export function encodeNearDelegateAction(d: NearDelegateAction): Bytes {
  const w = new BorshWriter();
  writeDelegate(w, d);
  return w.bytes();
}

/** borsh(SignedDelegateAction): the delegate action's own bytes, then the signature. */
export function encodeNearSignedDelegateAction(delegateBytes: Uint8Array, sig: NearSignature): Bytes {
  const w = new BorshWriter().raw(delegateBytes);
  writeSignature(w, sig);
  return w.bytes();
}

/** NEP-413's `u32le(2^31 + 413) ‖ borsh(Payload)`. Throws on a nonce that isn't 32 bytes or a field NEP-413 refuses. */
export function encodeNep413Message(p: Nep413Payload): Bytes {
  if (!(p.nonce instanceof Uint8Array) || p.nonce.length !== 32) throw new RangeError('NEP-413 nonce must be 32 bytes');
  checkNep413Fields(p.recipient, p.callbackUrl);
  const w = new BorshWriter().u32(NEP413_TAG).string(p.message).fixed(p.nonce, 32).string(p.recipient);
  if (p.callbackUrl === null) w.u8(0);
  else w.u8(1).string(p.callbackUrl);
  return w.bytes();
}

// ---- hashes ----

/** A transaction's hash (and what its signature signs): sha256(borsh(Transaction)). */
export const nearTransactionHash = (txBytes: Uint8Array): Bytes => sha256(txBytes);

/** The transaction hash as NEAR RPCs and explorers print it (base58). */
export const nearTransactionHashString = (txBytes: Uint8Array): string => base58.encode(nearTransactionHash(txBytes));

/** NEP-461's message of a delegate action: u32le(2^30 + 366) ‖ borsh(DelegateAction). */
export const nearDelegateActionMessage = (delegateBytes: Uint8Array): Bytes => concatBytes(u32le(NEP366_SIGNING_PREFIX), delegateBytes);

/** What a delegate action's signature signs: sha256(u32le(2^30 + 366) ‖ borsh(DelegateAction)). */
export const nearDelegateActionHash = (delegateBytes: Uint8Array): Bytes => sha256(nearDelegateActionMessage(delegateBytes));

/** What a NEP-413 signature signs: sha256 of encodeNep413Message's bytes. */
export const nep413Hash = (messageBytes: Uint8Array): Bytes => sha256(messageBytes);

/** `ed25519:<base58>` of a decoded public key. */
export const nearKeyString = (pk: NearPublicKey): string => nearPublicKeyString(pk.bytes, pk.type);
